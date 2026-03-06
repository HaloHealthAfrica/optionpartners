'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');
const calibrationStore = require('./adaptive-intelligence/calibration-store.service');
const { getETMinutes, getETDate, deriveSessionPhase } = require('../../utils/timezone');

/**
 * Deterministic Trade Decision Engine.
 *
 * Evaluates a SymbolState (built from accumulated webhook data) and produces
 * a fully structured TradeDecision. No guessing, no vague scoring — every
 * rule is explicit and auditable.
 *
 * Pipeline position: replaces market-intelligence.js in the decision-router.
 * Runs after safety/adaptive guards, before options construction.
 *
 * Implements:
 *   Part 2 — Webhook classification rules
 *   Part 3 — Conviction model
 *   Part 4 — Trade type decision (CALL / PUT / SPREAD / BLOCK)
 *   Part 5 — Strike/delta selection
 *   Part 6 — DTE logic
 *   Part 7 — Exit parameters
 *   Part 8 — Fail-closed rules
 *   Part 9 — Structured output
 */

/**
 * @typedef {Object} TradeDecision
 * @property {'BUY_CALL'|'BUY_PUT'|'SELL_SPREAD'|'EXIT'|'BLOCK'} action
 * @property {string} ticker
 * @property {number|null} strike
 * @property {string|null} expiry
 * @property {number} delta_target
 * @property {number} delta_min
 * @property {number} delta_max
 * @property {number} dte_target
 * @property {number} dte_min
 * @property {number} dte_max
 * @property {number} size_multiplier
 * @property {number} conviction_score
 * @property {string[]} rationale
 * @property {{ stop_level: number|null, max_loss: number|null }} risk_parameters
 * @property {string|null} contractType - For options constructor: CALL, PUT, CREDIT_SPREAD
 */

class TradeDecisionEngine {
  /**
   * Evaluate a signal against the accumulated SymbolState.
   * Returns a deterministic TradeDecision.
   *
   * @param {Object} signal - Normalized SimSignal from signal.contract.js
   * @param {Object} symbolState - Rolling state from symbol-state.service.js
   * @param {Object} accountState - Account state row from sim_account_state
   * @param {string} userId
   * @param {Object} [marketContext] - Optional IV/GEX/flow context from market-context.service
   * @param {Object} [globalState] - Optional global market state for chain/price staleness
   * @returns {Promise<TradeDecision>}
   */
  async evaluate(signal, symbolState, accountState, userId, marketContext = null, globalState = null) {
    const rationale = [];
    const ticker = signal.symbol || symbolState.symbol;

    // ── Part 8: Fail-closed checks (run first — reject before any analysis) ──
    const failClosed = this._checkFailClosed(symbolState, accountState, rationale, globalState);
    if (failClosed) return failClosed;

    // ── Session quality gate: prefer 9:30-10:00 ET window ──
    // The 9:30-10:00 window has 68.2% WR with MEDIUM_CONFIDENCE.
    // Trades outside this window require valid regime classification to proceed.
    const sessionGate = this._applySessionQualityGate(symbolState, rationale);
    if (sessionGate.blocked) {
      return this._blocked(ticker, 0, rationale);
    }

    // ── PIVOT_MB: Self-contained mechanical evaluation ──
    if (signal.strategy === 'pivot_motherbar') {
      return this._evaluatePivotMotherBar(signal, symbolState, rationale);
    }

    // ── SQUEEZE_PRO: Self-contained mechanical evaluation ──
    if (signal.strategy === 'squeeze_pro') {
      return this._evaluateSqueezePro(signal, symbolState, rationale);
    }

    // ── Part 2: Signal preconditions ──
    const entrySignal = symbolState.latest_entry_signal;
    const isOrbTrigger = signal.indicatorSource === 'ORB';
    const isStratTrigger = signal.indicatorSource === 'STRAT';
    const preconditions = isOrbTrigger
      ? this._validateOrbPreconditions(symbolState, rationale)
      : isStratTrigger
        ? this._validateStratPreconditions(entrySignal, symbolState, rationale)
        : this._validateSignalsPreconditions(entrySignal, symbolState, rationale);

    if (!preconditions.valid) {
      return this._blocked(ticker, preconditions.conviction, rationale);
    }

    // ── Part 2: MTF_BIAS rules (macro authority) ──
    const macroCheck = this._applyMacroRules(signal, symbolState, rationale);
    if (macroCheck.blocked) {
      return this._blocked(ticker, 0, rationale);
    }

    // ── Part 2: TREND alignment check (penalty-based, not a hard gate) ──
    const trendCheck = this._applyTrendRules(symbolState, rationale);

    // ── Part 3: Conviction calculation (with optional calibrated weights + market context) ──
    let calibratedWeights = null;
    try {
      calibratedWeights = await calibrationStore.getWeightMap(userId);
    } catch (_) { /* proceed with static weights */ }
    let conviction = this._computeConviction(signal, symbolState, rationale, calibratedWeights, marketContext);

    // Apply macro penalty after conviction is computed
    if (macroCheck.penalty > 0) {
      conviction = Math.max(0, conviction - macroCheck.penalty);
      rationale.push(`CONVICTION after macro penalty: ${conviction}`);
    }

    // Apply trend penalty after conviction is computed
    if (trendCheck.penalty > 0) {
      conviction = Math.max(0, conviction - trendCheck.penalty);
      rationale.push(`CONVICTION after trend penalty: ${conviction}`);
    }

    // Apply staleness penalties
    if (symbolState.macro_updated_at) {
      const macroAgeMs = Date.now() - new Date(symbolState.macro_updated_at).getTime();
      const STATE_TTL_MS = parseInt(process.env.SIM_STATE_TTL_MS || '1800000', 10);
      if (macroAgeMs > STATE_TTL_MS) {
        conviction = Math.max(0, conviction - 10);
        rationale.push(`CONVICTION -10: stale macro data (${Math.round(macroAgeMs / 1000)}s old)`);
      }
    }
    if (symbolState.local_updated_at) {
      const localAgeMs = Date.now() - new Date(symbolState.local_updated_at).getTime();
      const STATE_TTL_MS = parseInt(process.env.SIM_STATE_TTL_MS || '1800000', 10);
      if (localAgeMs > STATE_TTL_MS) {
        conviction = Math.max(0, conviction - 10);
        rationale.push(`CONVICTION -10: stale trend data (${Math.round(localAgeMs / 1000)}s old)`);
      }
    }

    if (conviction < 40) {
      rationale.push(`CONVICTION_FAIL: Score ${conviction} below minimum 40`);
      return this._blocked(ticker, conviction, rationale);
    }

    // ── Part 4: Trade type decision ──
    const tradeType = this._determineTradeType(signal, symbolState, conviction, rationale, marketContext);

    // ── Part 5: Delta target selection (IV-adjusted) ──
    const deltaTargets = this._selectDeltaTargets(conviction, tradeType, rationale, marketContext);

    // ── Part 6: DTE logic (IV-adjusted) ──
    const dteTargets = this._selectDteRange(symbolState, isOrbTrigger, rationale, marketContext);

    // ── Part 7: Exit / risk parameters (GEX-aware) ──
    const riskParams = this._computeRiskParameters(signal, symbolState, entrySignal, rationale, marketContext);

    // ── Part 3: Size multiplier from conviction ──
    let sizeMultiplier = this._convictionToSize(conviction);

    // REVSTRAT pattern: highest R:R but lowest win rate — reduce size
    const stratPatternKind = (symbolState.latest_strat_signal?.pattern_kind || '').toUpperCase();
    if (stratPatternKind === 'REVSTRAT' && sizeMultiplier > 0.75) {
      sizeMultiplier = 0.75;
      rationale.push(`SIZE: 0.75x (REVSTRAT size reduction, conviction=${conviction})`);
    } else {
      rationale.push(`SIZE: ${sizeMultiplier}x (conviction=${conviction})`);
    }

    // Performance-based size reduction for struggling strategies.
    // Strategies with documented 0% WR at small sample sizes get minimum sizing
    // until they prove positive expectancy at n>=10.
    const perfSizeReduction = await this._applyPerformanceSizeReduction(signal.strategy, userId, rationale);
    if (perfSizeReduction.reduced) {
      sizeMultiplier = Math.min(sizeMultiplier, perfSizeReduction.maxSize);
    }

    // ── Part 9: Build structured output ──
    const action = tradeType === 'CREDIT_SPREAD' ? 'SELL_SPREAD'
      : tradeType === 'CALL' ? 'BUY_CALL'
      : tradeType === 'PUT' ? 'BUY_PUT'
      : 'BLOCK';

    logger.info(
      `[ENGINE] ${ticker} → ${action} conviction=${conviction} delta=${deltaTargets.target} ` +
      `dte=${dteTargets.target} size=${sizeMultiplier}x regime=${symbolState.regime}`,
      'trade-decision-engine'
    );

    return {
      action,
      ticker,
      strike: null,
      expiry: null,
      delta_target: deltaTargets.target,
      delta_min: deltaTargets.min,
      delta_max: deltaTargets.max,
      dte_target: dteTargets.target,
      dte_min: dteTargets.min,
      dte_max: dteTargets.max,
      size_multiplier: sizeMultiplier,
      conviction_score: conviction,
      rationale,
      risk_parameters: riskParams,
      contractType: tradeType === 'CREDIT_SPREAD' ? 'CREDIT_SPREAD' : tradeType,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 8 — FAIL-CLOSED RULES
  // ═══════════════════════════════════════════════════════════════════

  _checkFailClosed(state, accountState, rationale, globalState) {
    const ticker = state.symbol;
    const STATE_TTL_MS = parseInt(process.env.SIM_STATE_TTL_MS || '1800000', 10); // 30 min default

    // Chain data validation: check both user state and global market state.
    // Global state is authoritative for market data.
    const requireChain = process.env.SIM_REQUIRE_CHAIN_DATA !== 'false';
    const chainUpdatedAt = globalState?.chain_updated_at || state.chain_updated_at;
    const chainOk = globalState?.chain_ok ?? state.chain_ok;

    if (chainUpdatedAt && !chainOk) {
      rationale.push('FAIL_CLOSED: Chain data present but no valid contracts');
      return this._blocked(ticker, 0, rationale);
    }
    if (!chainUpdatedAt) {
      if (requireChain) {
        rationale.push('FAIL_CLOSED: No chain data received — cannot validate options liquidity');
        return this._blocked(ticker, 0, rationale);
      }
      rationale.push('WARN: No chain data — proceeding without options liquidity validation');
    }

    // Chain staleness check — use longer TTL outside RTH since options
    // markets are closed and previous-session chain data is still valid.
    if (chainUpdatedAt) {
      const chainAgeMs = Date.now() - new Date(chainUpdatedAt).getTime();
      const etMins = getETMinutes();
      const isRTH = etMins >= 570 && etMins <= 960; // 9:30-16:00 ET
      const chainTtlMs = isRTH
        ? STATE_TTL_MS
        : parseInt(process.env.SIM_CHAIN_TTL_OFF_HOURS_MS || '64800000', 10); // 18h default
      if (chainAgeMs > chainTtlMs) {
        if (requireChain) {
          rationale.push(`FAIL_CLOSED: Chain data stale (${Math.round(chainAgeMs / 1000)}s old, max ${chainTtlMs / 1000}s)`);
          return this._blocked(ticker, 0, rationale);
        }
        rationale.push(`WARN: Chain data stale (${Math.round(chainAgeMs / 1000)}s) — proceeding anyway`);
      }
    }

    // Price data: check global state first, then user state
    const priceUpdatedAt = globalState?.price_updated_at || state.price_updated_at;
    const lastPrice = (globalState?.last_price ? parseFloat(globalState.last_price) : null) || state.last_price;

    if (!priceUpdatedAt && !lastPrice) {
      rationale.push('WARN: No dedicated price feed — will use signal-embedded price');
    }
    if (priceUpdatedAt) {
      const priceAgeMs = Date.now() - new Date(priceUpdatedAt).getTime();
      if (priceAgeMs > 5 * 60 * 1000) {
        rationale.push(`WARN: Price data stale (${Math.round(priceAgeMs / 1000)}s old)`);
      }
    }

    // Macro bias staleness — demote to warning so SIGNALS can trade standalone.
    // Only hard-block if data is severely stale (> 4x TTL, i.e. 2 hours default).
    if (state.macro_updated_at) {
      const macroAgeMs = Date.now() - new Date(state.macro_updated_at).getTime();
      if (macroAgeMs > STATE_TTL_MS * 4) {
        rationale.push(`FAIL_CLOSED: Macro bias severely stale (${Math.round(macroAgeMs / 1000)}s old)`);
        return this._blocked(ticker, 0, rationale);
      }
      if (macroAgeMs > STATE_TTL_MS) {
        rationale.push(`WARN: Macro bias stale (${Math.round(macroAgeMs / 1000)}s old) — conviction penalty applied`);
      }
    }

    // Trend alignment staleness — same graceful degradation.
    if (state.local_updated_at) {
      const localAgeMs = Date.now() - new Date(state.local_updated_at).getTime();
      if (localAgeMs > STATE_TTL_MS * 4) {
        rationale.push(`FAIL_CLOSED: Trend data severely stale (${Math.round(localAgeMs / 1000)}s old)`);
        return this._blocked(ticker, 0, rationale);
      }
      if (localAgeMs > STATE_TTL_MS) {
        rationale.push(`WARN: Trend data stale (${Math.round(localAgeMs / 1000)}s old) — conviction penalty applied`);
      }
    }

    // Spread check: configurable threshold, skip when chain data is stale
    const maxSpread = parseFloat(process.env.SIM_MAX_SPREAD_PCT || '0.20');
    if (state.bid_ask_spread_pct != null && state.bid_ask_spread_pct > maxSpread) {
      const chainAge = globalState?.chain_updated_at
        ? (Date.now() - new Date(globalState.chain_updated_at).getTime()) / 1000
        : null;
      if (chainAge != null && chainAge > 600) {
        rationale.push(
          `WARN: Bid-ask spread ${(state.bid_ask_spread_pct * 100).toFixed(1)}% exceeds ${(maxSpread * 100).toFixed(0)}% max ` +
          `but chain data is stale (${Math.round(chainAge)}s old) — skipping spread gate`
        );
      } else {
        rationale.push(`FAIL_CLOSED: Bid-ask spread ${(state.bid_ask_spread_pct * 100).toFixed(1)}% exceeds ${(maxSpread * 100).toFixed(0)}% max`);
        return this._blocked(ticker, 0, rationale);
      }
    }

    if (accountState) {
      const isNewDay = accountState.daily_pnl_reset_at
        && getETDate() > String(accountState.daily_pnl_reset_at).slice(0, 10);
      const effectiveDailyPnl = isNewDay ? 0 : parseFloat(accountState.daily_pnl || 0);
      const dailyLoss = Math.abs(Math.min(0, effectiveDailyPnl));
      const maxDailyLoss = parseFloat(process.env.SIM_MAX_DAILY_LOSS || '2000');
      if (dailyLoss >= maxDailyLoss) {
        rationale.push(`FAIL_CLOSED: Daily loss $${dailyLoss.toFixed(2)} >= max $${maxDailyLoss}`);
        return this._blocked(ticker, 0, rationale);
      }
    }

    if (state.macro_bias !== 'NEUTRAL' && state.local_bias !== 'NEUTRAL'
      && state.macro_bias !== state.local_bias) {
      const mismatchSeverity = state.conflict_score || 0;
      if (mismatchSeverity > 50) {
        rationale.push(`FAIL_CLOSED: Macro/local bias mismatch too severe (conflict_score=${mismatchSeverity})`);
        return this._blocked(ticker, 0, rationale);
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 2 — SIGNALS PRECONDITIONS
  // ═══════════════════════════════════════════════════════════════════

  _validateSignalsPreconditions(entrySignal, state, rationale) {
    if (!entrySignal) {
      rationale.push('PRECONDITION_FAIL: No entry signal in state');
      return { valid: false, conviction: 0 };
    }

    const failures = [];
    let convictionPenalty = 0;

    if ((entrySignal.confidence || 0) < 40) {
      failures.push(`confidence=${entrySignal.confidence} < 40`);
    }
    if (entrySignal.rr_ratio != null && entrySignal.rr_ratio < 1.5) {
      failures.push(`rr_ratio=${entrySignal.rr_ratio} < 1.5`);
    }
    if (entrySignal.market_session && entrySignal.market_session !== 'REGULAR'
      && entrySignal.market_session !== 'regular') {
      failures.push(`market_session=${entrySignal.market_session} != REGULAR`);
    }
    if (state.atr != null && state.atr <= 0) {
      failures.push('ATR is zero or negative');
    }

    // Counter-macro: penalize instead of hard-blocking. Very high-confidence
    // signals (>= 85) are allowed through with a smaller penalty to capture
    // mean-reversion opportunities at extremes.
    const signalDir = entrySignal.direction;
    if (signalDir && state.macro_bias !== 'NEUTRAL' && state.macro_bias) {
      const macroDirLong = state.macro_bias === 'BULLISH';
      const signalIsLong = signalDir === 'long';
      if (macroDirLong !== signalIsLong) {
        const confidence = entrySignal.confidence || 0;
        if (confidence >= 85) {
          convictionPenalty += 15;
          rationale.push(`MACRO_CONFLICT_PENALTY -15: ${state.macro_bias} conflicts with ${signalDir} (high confidence ${confidence} — allowing with penalty)`);
        } else {
          convictionPenalty += 25;
          rationale.push(`MACRO_CONFLICT_PENALTY -25: ${state.macro_bias} conflicts with ${signalDir} (confidence ${confidence} — heavy penalty)`);
        }
      }
    }

    if (failures.length > 0) {
      rationale.push(`PRECONDITION_FAIL: ${failures.join('; ')}`);
      return { valid: false, conviction: 0 };
    }

    rationale.push('PRECONDITIONS: All SIGNALS checks passed');
    return { valid: true, conviction: (entrySignal.confidence || 0) - convictionPenalty };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 2 — ORB PRECONDITIONS
  // ═══════════════════════════════════════════════════════════════════

  _validateOrbPreconditions(state, rationale) {
    const orb = state.latest_orb_signal;
    if (!orb) {
      rationale.push('PRECONDITION_FAIL: No ORB signal in state');
      return { valid: false, conviction: 0 };
    }

    const failures = [];

    // ORB only valid within first 2 hours of session (09:30 - 11:30 ET)
    const etTime = getETMinutes();
    if (etTime > 11 * 60 + 30) {
      failures.push('ORB past 2-hour session window (after 11:30 ET)');
    }

    if (state.macro_bias !== 'NEUTRAL') {
      const orbDirLong = orb.direction === 'long';
      const macroLong = state.macro_bias === 'BULLISH';
      if (orbDirLong !== macroLong) {
        failures.push(`macro_bias=${state.macro_bias} conflicts with ORB direction=${orb.direction}`);
      }
    }

    if (state.regime === 'CHOP') {
      failures.push('regime=CHOP — ORB breakouts invalid in chop');
    }

    if (state.volatility_state && !state.volatility_state.toUpperCase().includes('EXPAN')
      && state.atr != null && state.atr <= 0) {
      failures.push('No ATR expansion — ORB requires expanding volatility');
    }

    if (failures.length > 0) {
      rationale.push(`ORB_PRECONDITION_FAIL: ${failures.join('; ')}`);
      return { valid: false, conviction: 0 };
    }

    rationale.push('ORB_PRECONDITIONS: All checks passed');
    return { valid: true, conviction: 60 };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 2 — STRAT PRECONDITIONS
  // ═══════════════════════════════════════════════════════════════════

  _validateStratPreconditions(entrySignal, state, rationale) {
    if (!entrySignal) {
      rationale.push('STRAT_PRECONDITION_FAIL: No entry signal in state');
      return { valid: false, conviction: 0 };
    }

    const failures = [];
    let convictionPenalty = 0;

    if (!entrySignal.entry_price || entrySignal.entry_price <= 0) {
      failures.push('entry_price missing or <= 0');
    }
    if (!entrySignal.stop_loss || entrySignal.stop_loss <= 0) {
      failures.push('stop_loss missing or <= 0');
    }
    if (!entrySignal.target_1 || entrySignal.target_1 <= 0) {
      failures.push('target missing or <= 0');
    }

    if ((entrySignal.confidence || 0) < 40) {
      failures.push(`confidence=${entrySignal.confidence} < 40`);
    }

    if (entrySignal.rr_ratio != null && entrySignal.rr_ratio < 1.2) {
      failures.push(`rr_ratio=${entrySignal.rr_ratio} < 1.2`);
    }

    // Counter-macro: penalize instead of hard-blocking.
    // STRAT setups with strong levels can be valid counter-trend reversals.
    const signalDir = entrySignal.direction;
    if (signalDir && state.macro_bias !== 'NEUTRAL' && state.macro_bias) {
      const macroDirLong = state.macro_bias === 'BULLISH';
      const signalIsLong = signalDir === 'long';
      if (macroDirLong !== signalIsLong) {
        const confidence = entrySignal.confidence || 0;
        if (confidence >= 85) {
          convictionPenalty += 15;
          rationale.push(`STRAT_MACRO_CONFLICT_PENALTY -15: ${state.macro_bias} conflicts with ${signalDir} (high confidence ${confidence})`);
        } else {
          convictionPenalty += 25;
          rationale.push(`STRAT_MACRO_CONFLICT_PENALTY -25: ${state.macro_bias} conflicts with ${signalDir} (confidence ${confidence})`);
        }
      }
    }

    // V2 pattern quality gates
    const strat = state.latest_strat_signal;
    if (strat?.pattern_kind) {
      const patternStr = (entrySignal.pattern || '').toUpperCase();
      if (patternStr.includes('FAILED')) {
        failures.push(`pattern=${patternStr} (FAILED — heuristic, low reliability)`);
      }

      if (strat.continuity === false && strat.pattern_kind === 'REVERSAL') {
        failures.push('continuity=false with REVERSAL pattern (fighting HTF)');
      }
    }

    if (failures.length > 0) {
      rationale.push(`STRAT_PRECONDITION_FAIL: ${failures.join('; ')}`);
      return { valid: false, conviction: 0 };
    }

    rationale.push('STRAT_PRECONDITIONS: All checks passed');
    return { valid: true, conviction: (entrySignal.confidence || 75) - convictionPenalty };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 2 — MACRO RULES (MTF_BIAS authority)
  // ═══════════════════════════════════════════════════════════════════

  _applyMacroRules(signal, state, rationale) {
    const dir = signal.direction || state.latest_entry_signal?.direction;
    const isLong = dir === 'long';
    let penalty = 0;

    // Regime-based penalties
    if (state.regime === 'TREND' && state.macro_strength >= 65) {
      rationale.push(`MACRO: regime=TREND macro_strength=${state.macro_strength} — trend trades only`);
    }

    if (state.regime === 'CHOP') {
      penalty += 10;
      rationale.push('MACRO_PENALTY -10: regime=CHOP — breakout trades penalized, prefer spreads');
    }

    // Room-to-move penalties (applied directly to conviction)
    if (isLong && state.room_to_resistance === 'LOW') {
      penalty += 15;
      rationale.push('MACRO_PENALTY -15: room_to_resistance=LOW — limited upside for CALL');
    }

    if (!isLong && state.room_to_support === 'LOW') {
      penalty += 15;
      rationale.push('MACRO_PENALTY -15: room_to_support=LOW — limited downside for PUT');
    }

    return { blocked: false, penalty };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 2 — TREND DOT RULES
  // ═══════════════════════════════════════════════════════════════════

  _applyTrendRules(state, rationale) {
    // No TREND data yet — proceed without alignment check
    if (!state.local_updated_at) {
      rationale.push('TREND: No trend data yet — skipping alignment check');
      return { blocked: false, penalty: 0 };
    }

    // Trend alignment and conflict are conviction modifiers, not hard gates.
    // This allows SIGNALS to trade standalone when trend data is partial or weak.
    let penalty = 0;

    if (state.alignment_score < 30) {
      penalty += 20;
      rationale.push(`TREND_PENALTY -20: alignment_score=${state.alignment_score} < 30 (very weak)`);
    } else if (state.alignment_score < 45) {
      penalty += 10;
      rationale.push(`TREND_PENALTY -10: alignment_score=${state.alignment_score} < 45 (weak)`);
    }

    if (state.conflict_score > 60) {
      penalty += 15;
      rationale.push(`TREND_PENALTY -15: conflict_score=${state.conflict_score} > 60 (high conflict)`);
    } else if (state.conflict_score > 40) {
      penalty += 10;
      rationale.push(`TREND_PENALTY -10: conflict_score=${state.conflict_score} > 40 (moderate conflict)`);
    }

    if (state.alignment_score >= 75) {
      rationale.push(`TREND: alignment=${state.alignment_score} ≥ 75 — aggressive delta allowed`);
    }

    return { blocked: false, penalty };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 3 — CONVICTION MODEL
  // ═══════════════════════════════════════════════════════════════════

  _computeConviction(signal, state, rationale, calibratedWeights = null, marketContext = null) {
    const entry = state.latest_entry_signal;
    const dir = signal.direction || entry?.direction;
    const w = (key, staticVal) => calibratedWeights?.get(key) ?? staticVal;
    const usingCal = !!calibratedWeights;

    // Base: SIGNALS confidence
    let conviction = entry?.confidence || 0;
    rationale.push(`CONVICTION_BASE: ${conviction} (SIGNALS confidence${usingCal ? ', calibrated weights active' : ''})`);

    // +STRAT alignment
    if (state.latest_strat_signal && state.strat_signal_at) {
      const stratDir = state.latest_strat_signal.direction;
      if (stratDir === dir) {
        const wt = w('strat_align', 10);
        conviction += wt;
        rationale.push(`CONVICTION +${wt}: STRAT direction aligns`);
      } else if (stratDir && stratDir !== dir) {
        if ((entry?.confidence || 0) < 70) {
          rationale.push(`STRAT_CONFLICT_BLOCK: STRAT=${stratDir} conflicts, confidence=${entry?.confidence} < 70`);
          return 0;
        }
        const wt = w('strat_conflict', -10);
        conviction += wt;
        rationale.push(`CONVICTION ${wt}: STRAT direction conflicts (confidence >= 70, proceeding)`);
      }

      const stratSignal = state.latest_strat_signal;
      if (stratSignal.pattern_kind) {
        if (stratSignal.continuity === true) {
          const wt = w('strat_continuity', 10);
          conviction += wt;
          rationale.push(`CONVICTION +${wt}: STRAT continuity (weekly aligns with daily setup)`);
        } else if (stratSignal.continuity === false && stratSignal.pattern_kind === 'REVERSAL') {
          const wt = w('strat_no_cont', -15);
          conviction += wt;
          rationale.push(`CONVICTION ${wt}: STRAT no continuity + REVERSAL (fighting HTF)`);
        }

        const kind = stratSignal.pattern_kind.toUpperCase();
        if (kind === 'CONTINUATION') {
          const wt = w('continuation', 10);
          conviction += wt;
          rationale.push(`CONVICTION +${wt}: CONTINUATION pattern (highest win rate)`);
        } else if (kind === 'REVSTRAT') {
          const wt = w('revstrat', -5);
          conviction += wt;
          rationale.push(`CONVICTION ${wt}: REVSTRAT pattern (high R:R but low win rate — size down)`);
        }
      }
    }

    // +TREND alignment boost
    if (state.alignment_score >= 75) {
      const wt = w('trend_high', 15);
      conviction += wt;
      rationale.push(`CONVICTION +${wt}: TREND alignment=${state.alignment_score} ≥ 75`);
    } else if (state.alignment_score >= 65) {
      const wt = w('trend_mid', 10);
      conviction += wt;
      rationale.push(`CONVICTION +${wt}: TREND alignment=${state.alignment_score} ≥ 65`);
    }

    // +FLOW boost
    if (state.latest_flow_signal && state.flow_signal_at) {
      const flow = state.latest_flow_signal;
      const flowAligns = flow.direction === dir;
      const flowConflicts = flow.direction && flow.direction !== dir;

      if (flowAligns && flow.unusual) {
        const wt = w('flow_unusual', 15);
        conviction += wt;
        rationale.push(`CONVICTION +${wt}: Unusual options flow aligns with signal`);
      } else if (flowAligns) {
        const wt = w('flow_aligns', 8);
        conviction += wt;
        rationale.push(`CONVICTION +${wt}: Options flow aligns with signal`);
      } else if (flowConflicts && flow.unusual) {
        if (state.macro_strength < 75) {
          rationale.push(`FLOW_CONFLICT_BLOCK: Large opposing flow, macro_strength=${state.macro_strength} < 75`);
          return 0;
        }
        const wt = w('flow_conflict', -5);
        conviction += wt;
        rationale.push(`CONVICTION ${wt}: Large opposing flow (macro_strength ≥ 75, proceeding)`);
      }
    }

    // +SATY_PHASE alignment
    if (state.latest_saty_signal && state.saty_signal_at) {
      const satyDir = state.latest_saty_signal.direction;
      if (satyDir === dir) {
        const wt = w('saty_aligns', 8);
        conviction += wt;
        rationale.push(`CONVICTION +${wt}: SATY_PHASE direction aligns`);
      } else if (satyDir && satyDir !== dir) {
        const wt = w('saty_conflict', -5);
        conviction += wt;
        rationale.push(`CONVICTION ${wt}: SATY_PHASE direction conflicts`);
      }
    }

    // Room and CHOP penalties are now applied via _applyMacroRules to avoid
    // double-counting. Only CONTRACTION remains here since it's not macro-related.

    // +Macro strength modifier (macro_strength / 10)
    if (state.macro_strength > 0) {
      const macroBonus = Math.round(state.macro_strength / 10);
      conviction += macroBonus;
      rationale.push(`CONVICTION +${macroBonus}: macro_strength=${state.macro_strength}`);
    }

    // -Regime mismatch penalties (CHOP is handled by _applyMacroRules)
    if (state.regime === 'CONTRACTION') {
      conviction -= 5;
      rationale.push('CONVICTION -5: CONTRACTION regime penalty');
    }

    // ── Market Context enrichment (IV / GEX / Flow from historical snapshots) ──
    if (marketContext) {
      // IV environment modifier
      if (marketContext.iv) {
        const ivRank = marketContext.iv.iv_rank;
        if (ivRank != null) {
          if (ivRank >= 80) {
            // High IV = premium is expensive; directional plays harder, spreads preferred
            const wt = w('iv_high', -5);
            conviction += wt;
            rationale.push(`CONVICTION ${wt}: IV_RANK=${ivRank.toFixed(0)} (elevated — premium expensive)`);
          } else if (ivRank <= 20) {
            // Very low IV = cheap premium, strong directional opportunity
            const wt = w('iv_low', 5);
            conviction += wt;
            rationale.push(`CONVICTION +${wt}: IV_RANK=${ivRank.toFixed(0)} (low — cheap premium)`);
          }
        }
      }

      // GEX environment modifier
      if (marketContext.gex) {
        const netGex = marketContext.gex.net_gex;
        if (netGex != null) {
          if (netGex < -500_000_000) {
            // Strong negative GEX = dealers amplify moves — good for directional
            const wt = w('gex_negative', 8);
            conviction += wt;
            rationale.push(`CONVICTION +${wt}: GEX strongly negative (${(netGex / 1e6).toFixed(0)}M — explosive potential)`);
          } else if (netGex > 500_000_000) {
            // Strong positive GEX = dealer hedging pins price — bad for directional
            const wt = w('gex_positive', -8);
            conviction += wt;
            rationale.push(`CONVICTION ${wt}: GEX strongly positive (${(netGex / 1e6).toFixed(0)}M — pinning risk)`);
          }
        }
      }

      // Historical flow snapshot validation
      if (marketContext.flow && dir) {
        const flowSentiment = marketContext.flow.sentiment;
        const pcr = marketContext.flow.put_call_ratio;
        const flowBullish = flowSentiment === 'bullish' || pcr < 0.7;
        const flowBearish = flowSentiment === 'bearish' || pcr > 1.3;
        const dirLong = dir === 'long';

        if ((dirLong && flowBullish) || (!dirLong && flowBearish)) {
          const wt = w('hist_flow_aligns', 5);
          conviction += wt;
          rationale.push(`CONVICTION +${wt}: Historical flow aligns (sentiment=${flowSentiment}, PCR=${pcr?.toFixed(2)})`);
        } else if ((dirLong && flowBearish) || (!dirLong && flowBullish)) {
          const wt = w('hist_flow_conflict', -5);
          conviction += wt;
          rationale.push(`CONVICTION ${wt}: Historical flow conflicts (sentiment=${flowSentiment}, PCR=${pcr?.toFixed(2)})`);
        }
      }
    }

    conviction = Math.max(0, Math.min(100, Math.round(conviction)));
    rationale.push(`CONVICTION_FINAL: ${conviction}`);
    return conviction;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 4 — TRADE TYPE DECISION
  // ═══════════════════════════════════════════════════════════════════

  _determineTradeType(signal, state, conviction, rationale, marketContext = null) {
    const dir = signal.direction || state.latest_entry_signal?.direction;
    // Prefer IV rank from historical snapshots over webhook-provided iv_percentile
    const ivFromSnapshot = marketContext?.iv?.iv_rank;
    const iv = ivFromSnapshot != null ? ivFromSnapshot : state.iv_percentile;

    // CREDIT SPREAD conditions
    if (iv != null && iv >= 70 && state.regime === 'CHOP' && conviction >= 60 && conviction < 80) {
      rationale.push(`TRADE_TYPE: CREDIT_SPREAD (IV=${iv.toFixed ? iv.toFixed(0) : iv}% ≥ 70, regime=CHOP, moderate conviction)`);
      return 'CREDIT_SPREAD';
    }
    if (iv != null && iv >= 80) {
      rationale.push(`TRADE_TYPE: CREDIT_SPREAD (IV=${iv.toFixed ? iv.toFixed(0) : iv}% ≥ 80 — prefer spreads over naked)`);
      return 'CREDIT_SPREAD';
    }

    // CALL conditions
    if (dir === 'long') {
      if (state.macro_bias !== 'BULLISH' && state.macro_bias !== 'NEUTRAL') {
        rationale.push('TRADE_TYPE_BLOCK: CALL requires BULLISH macro (not for NEUTRAL when data exists)');
        return 'BLOCK';
      }
      if (state.regime === 'CHOP') {
        rationale.push('TRADE_TYPE_BLOCK: CALL blocked — CHOP regime');
        return 'BLOCK';
      }
      rationale.push('TRADE_TYPE: CALL');
      return 'CALL';
    }

    // PUT conditions (mirror of CALL)
    if (dir === 'short') {
      if (state.macro_bias !== 'BEARISH' && state.macro_bias !== 'NEUTRAL') {
        rationale.push('TRADE_TYPE_BLOCK: PUT requires BEARISH macro');
        return 'BLOCK';
      }
      if (state.regime === 'CHOP') {
        rationale.push('TRADE_TYPE_BLOCK: PUT blocked — CHOP regime');
        return 'BLOCK';
      }
      rationale.push('TRADE_TYPE: PUT');
      return 'PUT';
    }

    rationale.push('TRADE_TYPE_BLOCK: No valid direction resolved');
    return 'BLOCK';
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 5 — DELTA TARGET SELECTION
  // ═══════════════════════════════════════════════════════════════════

  _selectDeltaTargets(conviction, tradeType, rationale, marketContext = null) {
    if (tradeType === 'CREDIT_SPREAD') {
      // In high IV, widen spread short leg to further OTM for higher probability
      if (marketContext?.iv?.iv_rank >= 70) {
        rationale.push(`DELTA: Spread short leg 0.25-0.30 delta (IV rank ${marketContext.iv.iv_rank.toFixed(0)} — wider strike)`);
        return { target: 0.25, min: 0.20, max: 0.30 };
      }
      rationale.push('DELTA: Spread short leg 0.30-0.35 delta');
      return { target: 0.30, min: 0.25, max: 0.35 };
    }

    let target, min, max;

    if (conviction >= 90) {
      target = 0.65; min = 0.60; max = 0.70;
      rationale.push(`DELTA: Conviction ${conviction} ≥ 90 → aggressive 0.60-0.70`);
    } else if (conviction >= 80) {
      target = 0.60; min = 0.55; max = 0.65;
      rationale.push(`DELTA: Conviction ${conviction} ≥ 80 → elevated 0.55-0.65`);
    } else {
      target = 0.50; min = 0.45; max = 0.55;
      rationale.push(`DELTA: Conviction ${conviction} 70-79 → standard 0.45-0.55`);
    }

    // IV-based delta adjustment: in very low IV, can go slightly more ITM (cheaper premium)
    if (marketContext?.iv?.iv_rank != null && marketContext.iv.iv_rank <= 20 && tradeType !== 'CREDIT_SPREAD') {
      target = Math.min(0.70, target + 0.05);
      max = Math.min(0.75, max + 0.05);
      rationale.push(`DELTA +0.05: Low IV rank (${marketContext.iv.iv_rank.toFixed(0)}) — cheaper premium allows higher delta`);
    }

    return { target, min, max };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 6 — DTE LOGIC
  // ═══════════════════════════════════════════════════════════════════

  _selectDteRange(state, isOrb, rationale, marketContext = null) {
    // ORB: short DTE
    if (isOrb) {
      rationale.push('DTE: ORB signal → 7-14 DTE');
      return { target: 10, min: 7, max: 14 };
    }

    // Strong trend: allow longer DTE
    if (state.macro_strength >= 80 && state.regime === 'TREND') {
      rationale.push(`DTE: Strong trend (macro_strength=${state.macro_strength}, regime=TREND) → 30-45 DTE`);
      return { target: 35, min: 30, max: 45 };
    }

    // Volatility expansion: shorten DTE
    if (state.regime === 'EXPANSION' || (state.volatility_state && state.volatility_state.toUpperCase().includes('EXPAN'))) {
      rationale.push('DTE: Volatility EXPANSION → 10-21 DTE');
      return { target: 14, min: 10, max: 21 };
    }

    // Volatility contraction: lengthen DTE
    if (state.regime === 'CONTRACTION' || (state.volatility_state && state.volatility_state.toUpperCase().includes('CONTRAC'))) {
      rationale.push('DTE: Volatility CONTRACTION → 21-45 DTE');
      return { target: 30, min: 21, max: 45 };
    }

    // IV-aware DTE adjustment on the default swing range
    if (marketContext?.iv?.iv_rank != null) {
      const ivRank = marketContext.iv.iv_rank;
      if (ivRank >= 70) {
        // High IV = accelerated theta decay — shorter DTE captures premium collapse
        rationale.push(`DTE: High IV rank (${ivRank.toFixed(0)}) → shortened 10-21 DTE`);
        return { target: 14, min: 10, max: 21 };
      }
      if (ivRank <= 20) {
        // Low IV = slow theta — extend DTE to give the trade room
        rationale.push(`DTE: Low IV rank (${ivRank.toFixed(0)}) → extended 21-45 DTE`);
        return { target: 30, min: 21, max: 45 };
      }
    }

    // Default swing: 14-30 DTE
    rationale.push('DTE: Default swing → 14-30 DTE');
    return { target: 21, min: 14, max: 30 };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 7 — EXIT / RISK PARAMETERS
  // ═══════════════════════════════════════════════════════════════════

  _computeRiskParameters(signal, state, entrySignal, rationale, marketContext = null) {
    let stopLevel = null;
    let stopSource = null;
    let maxLoss = null;
    const dir = signal.direction || entrySignal?.direction;
    const isLong = dir === 'long';

    // Stop hierarchy:
    // 1. Structure invalidation (from MTF risk_context)
    // The invalidation level is directional: for a long trade it must be
    // BELOW current price (support break), for a short trade it must be
    // ABOVE current price (resistance break). Ignore levels on the wrong
    // side — they represent the *target* zone, not the stop.
    const macroRaw = state.latest_macro_raw;
    const structureStop = macroRaw?.riskContext?.invalidation?.level;
    if (structureStop && state.last_price) {
      const level = parseFloat(structureStop);
      const isBelow = level < state.last_price;
      const isAbove = level > state.last_price;
      if ((isLong && isBelow) || (!isLong && isAbove)) {
        stopLevel = level;
        stopSource = 'STRUCTURE_INVALIDATION';
        rationale.push(`STOP: Structure invalidation from MTF @ ${stopLevel}`);
      } else {
        rationale.push(
          `STOP_SKIP: Structure invalidation @ ${level} is on the wrong side ` +
          `for ${dir} trade (price=${state.last_price}) — ignoring as stop`
        );
      }
    } else if (structureStop && !state.last_price) {
      stopLevel = parseFloat(structureStop);
      stopSource = 'STRUCTURE_INVALIDATION';
      rationale.push(`STOP: Structure invalidation from MTF @ ${stopLevel} (no price to validate direction)`);
    }

    // 2. SIGNALS stop_loss — validate direction consistency
    if (!stopLevel && entrySignal?.stop_loss) {
      const signalStop = parseFloat(entrySignal.stop_loss);
      if (state.last_price) {
        const stopIsBelow = signalStop < state.last_price;
        const stopIsAbove = signalStop > state.last_price;
        if ((isLong && stopIsBelow) || (!isLong && stopIsAbove)) {
          stopLevel = signalStop;
          stopSource = 'SIGNALS_STOP_LOSS';
          rationale.push(`STOP: SIGNALS stop_loss @ ${stopLevel}`);
        } else {
          rationale.push(
            `STOP_SKIP: Signal stop @ ${signalStop} is ${stopIsAbove ? 'above' : 'below'} ` +
            `price ${state.last_price} for a ${dir} trade — ignoring (likely target, not stop)`
          );
        }
      } else {
        stopLevel = signalStop;
        stopSource = 'SIGNALS_STOP_LOSS';
        rationale.push(`STOP: SIGNALS stop_loss @ ${stopLevel}`);
      }
    }

    // 3. ATR trailing (2x ATR) — prefer strat plan ATR when available
    const effectiveAtr = state.latest_strat_signal?.atr || state.atr;
    if (!stopLevel && effectiveAtr && state.last_price) {
      const atrMultiple = 2;
      stopLevel = isLong
        ? state.last_price - (effectiveAtr * atrMultiple)
        : state.last_price + (effectiveAtr * atrMultiple);
      stopSource = 'ATR_TRAILING';
      rationale.push(`STOP: ATR trailing (2x ATR=${effectiveAtr}) @ ${stopLevel.toFixed(2)}`);
    }

    // Max loss from signal risk data
    if (entrySignal?.max_loss) {
      maxLoss = entrySignal.max_loss;
    } else if (stopLevel && state.last_price) {
      maxLoss = Math.abs(state.last_price - stopLevel) * 100; // per contract
    }

    // GEX flip price proximity: tighten stops if price is near the GEX flip level
    let gexFlipDistance = null;
    if (marketContext?.gex?.flip_price && state.last_price && stopLevel) {
      const flipPrice = parseFloat(marketContext.gex.flip_price);
      if (flipPrice > 0) {
        gexFlipDistance = Math.abs(state.last_price - flipPrice) / state.last_price;
        const dir = signal.direction || entrySignal?.direction;

        if (gexFlipDistance < 0.005) {
          // Within 0.5% of GEX flip — high-conviction inflection zone
          rationale.push(`GEX_RISK: Price within ${(gexFlipDistance * 100).toFixed(2)}% of GEX flip @ ${flipPrice} — inflection zone`);
        } else if (gexFlipDistance < 0.02) {
          // Within 2% — use flip as natural stop/target reference
          if (dir === 'long' && flipPrice < state.last_price && flipPrice > stopLevel) {
            stopLevel = flipPrice;
            stopSource = 'GEX_FLIP';
            rationale.push(`STOP: Tightened to GEX flip @ ${flipPrice} (natural support)`);
          } else if (dir === 'short' && flipPrice > state.last_price && (stopLevel == null || flipPrice < stopLevel)) {
            stopLevel = flipPrice;
            stopSource = 'GEX_FLIP';
            rationale.push(`STOP: Tightened to GEX flip @ ${flipPrice} (natural resistance)`);
          }
        }
      }
    }

    return { stop_level: stopLevel, stop_source: stopSource, max_loss: maxLoss, gex_flip_distance: gexFlipDistance };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  PERFORMANCE-BASED SIZE REDUCTION
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Reduce sizing for strategies with demonstrated poor performance.
   * Strategies with 0% WR at n>=3 get minimum sizing (0.5x) until
   * they establish positive expectancy at n>=10 with WR>40%.
   */
  async _applyPerformanceSizeReduction(strategy, userId, rationale) {
    if (!strategy || !userId) return { reduced: false, maxSize: 1.0 };

    try {
      const result = await db.query(
        `SELECT win_rate, total_trades, profit_factor
         FROM strategy_scorecard
         WHERE user_id = $1 AND strategy = $2`,
        [userId, strategy]
      );

      if (result.rows.length === 0) return { reduced: false, maxSize: 1.0 };

      const scorecard = result.rows[0];
      const winRate = parseFloat(scorecard.win_rate);
      const totalTrades = parseInt(scorecard.total_trades);
      const profitFactor = parseFloat(scorecard.profit_factor);

      // n < 3: insufficient data for sizing reduction
      if (totalTrades < 3) return { reduced: false, maxSize: 1.0 };

      // 0% WR at n>=3: reduce to minimum (paper-trade equivalent)
      if (winRate === 0 && totalTrades >= 3) {
        rationale.push(
          `SIZE_REDUCTION: ${strategy} has 0% WR over ${totalTrades} trades — ` +
          `reducing to 0.5x minimum until WR improves above 40% at n>=10`
        );
        return { reduced: true, maxSize: 0.5 };
      }

      // WR < 30% at n>=5 with PF < 0.8: reduce sizing
      if (totalTrades >= 5 && winRate < 0.30 && profitFactor < 0.8) {
        rationale.push(
          `SIZE_REDUCTION: ${strategy} has ${(winRate * 100).toFixed(0)}% WR, PF=${profitFactor.toFixed(2)} ` +
          `over ${totalTrades} trades — reducing to 0.75x`
        );
        return { reduced: true, maxSize: 0.75 };
      }

      return { reduced: false, maxSize: 1.0 };
    } catch (_) {
      return { reduced: false, maxSize: 1.0 };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SESSION QUALITY GATE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Enforce session quality preferences based on empirical edge data.
   * 9:30-10:00 ET: free pass (validated edge window, 68.2% WR)
   * Outside 9:30-10:00: require regime != UNKNOWN (quality gate)
   *
   * This concentrates risk in the highest-edge window while allowing
   * trades outside it only when regime classification is functional.
   */
  _applySessionQualityGate(state, rationale) {
    const etMinutes = getETMinutes();
    const isValidatedWindow = etMinutes >= 570 && etMinutes < 600; // 9:30-10:00

    if (isValidatedWindow) {
      rationale.push('SESSION: Within 9:30-10:00 ET validated edge window — no regime gate required');
      return { blocked: false, penalty: 0 };
    }

    // Outside the validated window: require valid regime classification
    const regime = (state.regime || state.volatility_regime || '').toUpperCase();
    const regimeUnknown = !regime || regime === 'UNKNOWN' || regime === 'N/A' || regime === '';

    if (regimeUnknown) {
      const phase = deriveSessionPhase();
      rationale.push(
        `SESSION_GATE: Outside 9:30-10:00 window (phase=${phase}) with regime=${regime || 'UNKNOWN'} — ` +
        `valid regime required for post-opening trades`
      );
      return { blocked: true, penalty: 0 };
    }

    rationale.push(`SESSION: Outside 9:30-10:00 window but regime=${regime} is valid — allowing`);
    return { blocked: false, penalty: 0 };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SIZING & HELPERS
  // ═══════════════════════════════════════════════════════════════════

  _convictionToSize(conviction) {
    if (conviction >= 90) return 1.5;
    if (conviction >= 80) return 1.25;
    return 1.0;
  }

  _blocked(ticker, conviction, rationale) {
    return {
      action: 'BLOCK',
      ticker,
      strike: null,
      expiry: null,
      delta_target: 0,
      delta_min: 0,
      delta_max: 0,
      dte_target: 0,
      dte_min: 0,
      dte_max: 0,
      size_multiplier: 0,
      conviction_score: conviction || 0,
      rationale,
      risk_parameters: { stop_level: null, max_loss: null },
      contractType: null,
      rejection_reason: this._classifyRejectionReason(rationale),
    };
  }

  /**
   * Classify TRADE_ENGINE rejections into diagnostic sub-categories.
   * Enables breakdown analysis of why the engine is blocking trades.
   */
  _classifyRejectionReason(rationale) {
    const text = rationale.join(' ');

    if (/FAIL_CLOSED.*[Cc]hain/i.test(text)) return 'chain_data_unavailable';
    if (/FAIL_CLOSED.*[Ss]pread/i.test(text)) return 'bid_ask_spread_too_wide';
    if (/FAIL_CLOSED.*[Ss]tale/i.test(text)) return 'data_staleness';
    if (/FAIL_CLOSED.*[Dd]aily loss/i.test(text)) return 'daily_loss_limit';
    if (/FAIL_CLOSED.*[Mm]ismatch.*severe/i.test(text)) return 'macro_local_conflict';
    if (/PRECONDITION_FAIL|ORB_PRECONDITION_FAIL|STRAT_PRECONDITION_FAIL/i.test(text)) return 'precondition_fail';
    if (/CONVICTION_FAIL/i.test(text)) return 'conviction_below_threshold';
    if (/TRADE_TYPE_BLOCK/i.test(text)) return 'trade_type_blocked';
    if (/regime.*UNKNOWN/i.test(text)) return 'regime_unknown_block';
    if (/regime.*CHOP/i.test(text)) return 'regime_chop_block';
    if (/MACRO_CONFLICT/i.test(text)) return 'macro_conflict';
    if (/STRAT_CONFLICT_BLOCK/i.test(text)) return 'strat_conflict';
    if (/FLOW_CONFLICT_BLOCK/i.test(text)) return 'flow_conflict';
    if (/PIVOT_MB_BLOCK/i.test(text)) return 'pivot_mb_guard';
    if (/SQUEEZE_PRO_BLOCK/i.test(text)) return 'squeeze_pro_guard';
    if (/session|SESSION|INVALID_SESSION/i.test(text)) return 'session_filter';

    return 'other';
  }

  // ═══════════════════════════════════════════════════════════════════
  //  PIVOT_MB — Mechanical strategy evaluation
  // ═══════════════════════════════════════════════════════════════════

  _evaluatePivotMotherBar(signal, symbolState, rationale) {
    const ticker = signal.symbol || symbolState.symbol;
    const meta = signal.meta?.indicatorMeta;

    if (!meta) {
      rationale.push('PIVOT_MB_BLOCK: Missing indicatorMeta');
      return this._blocked(ticker, 0, rationale);
    }

    const trigger = meta.trigger;
    const targets = signal.meta?.targets || [];
    const entry = signal.limitPrice;
    const stop = signal.stopLoss;

    // ── 1. Session guard ──
    // Prefer fresh SATY_PHASE data, fall back to clock-derived phase
    let sessionPhase = '';
    if (symbolState.latest_saty_signal?.phaseName && symbolState.saty_signal_at) {
      const satyAgeMs = Date.now() - new Date(symbolState.saty_signal_at).getTime();
      if (satyAgeMs < 600_000) {
        sessionPhase = symbolState.latest_saty_signal.phaseName.toUpperCase();
      }
    }
    if (!sessionPhase) {
      sessionPhase = deriveSessionPhase();
    }

    if (sessionPhase !== 'OPENING_DRIVE' && sessionPhase !== 'MORNING') {
      rationale.push(`PIVOT_MB_BLOCK: INVALID_SESSION (phase=${sessionPhase || 'UNKNOWN'})`);
      return this._blocked(ticker, 0, rationale);
    }

    // ── 2. Confluence guard ──
    if ((signal.score || 0) < 70) {
      rationale.push(`PIVOT_MB_BLOCK: Confluence score ${signal.score || 0} < 70`);
      return this._blocked(ticker, 0, rationale);
    }

    // ── 3. Pivot zone guard ──
    const pivotPosition = meta.pivotPosition;

    if (signal.direction === 'long') {
      if (!pivotPosition || !['AT_S1', 'AT_S2'].includes(pivotPosition)) {
        rationale.push(`PIVOT_MB_BLOCK: Long requires pivotPosition AT_S1|AT_S2, got ${pivotPosition}`);
        return this._blocked(ticker, 0, rationale);
      }
    } else if (signal.direction === 'short') {
      if (!pivotPosition || !['AT_R1', 'AT_R2'].includes(pivotPosition)) {
        rationale.push(`PIVOT_MB_BLOCK: Short requires pivotPosition AT_R1|AT_R2, got ${pivotPosition}`);
        return this._blocked(ticker, 0, rationale);
      }
    } else {
      rationale.push('PIVOT_MB_BLOCK: No valid direction');
      return this._blocked(ticker, 0, rationale);
    }

    // ── 4. Trigger mode logic ──
    if (trigger === 'BREAK_CLOSE') {
      if ((meta.atrPercentile || 0) < 65) {
        rationale.push(`PIVOT_MB_BLOCK: BREAK_CLOSE requires atrPercentile >= 65, got ${meta.atrPercentile}`);
        return this._blocked(ticker, 0, rationale);
      }
      if ((meta.emaAlignment || 0) < 70) {
        rationale.push(`PIVOT_MB_BLOCK: BREAK_CLOSE requires emaAlignment >= 70, got ${meta.emaAlignment}`);
        return this._blocked(ticker, 0, rationale);
      }
    } else if (trigger === 'BREAK_RETEST') {
      if (!meta.motherBar) {
        rationale.push('PIVOT_MB_BLOCK: BREAK_RETEST requires motherBar data');
        return this._blocked(ticker, 0, rationale);
      }
      if (!meta.motherBar.retest_hold) {
        rationale.push('PIVOT_MB_BLOCK: BREAK_RETEST requires motherBar.retest_hold === true');
        return this._blocked(ticker, 0, rationale);
      }
      if ((meta.emaAlignment || 0) < 70) {
        rationale.push(`PIVOT_MB_BLOCK: BREAK_RETEST requires emaAlignment >= 70, got ${meta.emaAlignment}`);
        return this._blocked(ticker, 0, rationale);
      }
    } else {
      rationale.push(`PIVOT_MB_BLOCK: Unknown trigger type: ${trigger}`);
      return this._blocked(ticker, 0, rationale);
    }

    // ── 5. Reward validation ──
    if (entry == null || stop == null || targets.length === 0) {
      rationale.push('PIVOT_MB_BLOCK: Missing entry, stop, or targets for R:R validation');
      return this._blocked(ticker, 0, rationale);
    }

    const risk = Math.abs(entry - stop);
    const reward1 = Math.abs(targets[0] - entry);

    if (risk <= 0 || reward1 < risk) {
      rationale.push(`PIVOT_MB_BLOCK: R:R invalid (risk=${risk.toFixed(2)}, reward=${reward1.toFixed(2)})`);
      return this._blocked(ticker, 0, rationale);
    }

    // ── 6. All guards passed — build TradeDecision ──
    const conviction = signal.score;
    const action = signal.direction === 'long' ? 'BUY_CALL' : 'BUY_PUT';
    const contractType = signal.direction === 'long' ? 'CALL' : 'PUT';
    const deltaTargets = this._selectDeltaTargets(conviction, contractType, rationale);
    const sizeMultiplier = this._convictionToSize(conviction);

    rationale.push(`PIVOT_MB_APPROVED: trigger=${trigger} conviction=${conviction} pivot=${pivotPosition}`);
    rationale.push(`SIZE: ${sizeMultiplier}x (conviction=${conviction})`);
    rationale.push('DTE: PIVOT_MB → 3-14 DTE (short-term directional)');

    return {
      action,
      ticker,
      strike: null,
      expiry: null,
      delta_target: deltaTargets.target,
      delta_min: deltaTargets.min,
      delta_max: deltaTargets.max,
      dte_target: 7,
      dte_min: 3,
      dte_max: 14,
      size_multiplier: sizeMultiplier,
      conviction_score: conviction,
      rationale,
      risk_parameters: {
        stop_level: stop,
        stop_source: 'PIVOT_MB_SIGNAL',
        max_loss: risk * 100,
      },
      contractType,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SQUEEZE_PRO — Mechanical strategy evaluation
  // ═══════════════════════════════════════════════════════════════════

  _evaluateSqueezePro(signal, symbolState, rationale) {
    const ticker = signal.symbol || symbolState.symbol;
    const meta = signal.meta?.indicatorMeta;

    if (!meta) {
      rationale.push('SQUEEZE_PRO_BLOCK: Missing indicatorMeta');
      return this._blocked(ticker, 0, rationale);
    }

    const compressionScore = meta.compressionScore || signal.score || 0;
    const entry = signal.limitPrice;
    const stop = signal.stopLoss;
    const targets = signal.meta?.targets || [];
    const timeframe = signal.meta?.timeframe || '15';
    const trendAlignment = meta.trend?.alignment;
    const isLong = signal.direction === 'long';

    // ── 1. Chop guard: flat macro EMA + chop regime = sit out ──
    if (trendAlignment === 'neutral' && symbolState.regime === 'CHOP') {
      rationale.push('SQUEEZE_PRO_BLOCK: Trend neutral + CHOP regime — sit out');
      return this._blocked(ticker, 0, rationale);
    }

    // ── 2. Compression score guard ──
    if (compressionScore < 40) {
      rationale.push(`SQUEEZE_PRO_BLOCK: Compression score ${compressionScore} < 40 (weak squeeze)`);
      return this._blocked(ticker, 0, rationale);
    }

    // ── 3. Direction validation ──
    if (!signal.direction) {
      rationale.push('SQUEEZE_PRO_BLOCK: No valid direction');
      return this._blocked(ticker, 0, rationale);
    }

    // ── 4. R:R validation ──
    if (entry == null || stop == null) {
      rationale.push('SQUEEZE_PRO_BLOCK: Missing entry or stop for R:R validation');
      return this._blocked(ticker, 0, rationale);
    }

    const risk = Math.abs(entry - stop);
    if (risk <= 0) {
      rationale.push('SQUEEZE_PRO_BLOCK: Zero risk distance (entry === stop)');
      return this._blocked(ticker, 0, rationale);
    }

    if (targets.length > 0) {
      const reward1 = Math.abs(targets[0] - entry);
      const rrRatio = reward1 / risk;
      if (rrRatio < 1.5) {
        rationale.push(`SQUEEZE_PRO_BLOCK: R:R ${rrRatio.toFixed(2)} < 1.5 minimum`);
        return this._blocked(ticker, 0, rationale);
      }
      rationale.push(`SQUEEZE_PRO_RR: ${rrRatio.toFixed(2)}:1`);
    }

    // ── 5. Build conviction from compression + volume + HTF ──
    let conviction = signal.confidence || 0;

    if (compressionScore >= 80) {
      conviction += 10;
      rationale.push(`CONVICTION +10: High compression (${compressionScore})`);
    } else if (compressionScore >= 60) {
      conviction += 5;
      rationale.push(`CONVICTION +5: Moderate compression (${compressionScore})`);
    }

    const barsCompressed = meta.barsCompressed || 0;
    if (barsCompressed >= 15) {
      conviction += 5;
      rationale.push(`CONVICTION +5: Extended squeeze (${barsCompressed} bars compressed)`);
    }

    const volumeRatio = meta.volume?.ratio || 0;
    if (volumeRatio >= 2.0) {
      conviction += 5;
      rationale.push(`CONVICTION +5: Strong volume (${volumeRatio.toFixed(2)}x avg)`);
    }

    const htfBias = (meta.htf?.bias || '').toLowerCase();
    if ((isLong && htfBias === 'bullish') || (!isLong && htfBias === 'bearish')) {
      conviction += 5;
      rationale.push(`CONVICTION +5: HTF bias aligns (${htfBias})`);
    }

    conviction = Math.max(0, Math.min(100, conviction));

    if (conviction < 40) {
      rationale.push(`SQUEEZE_PRO_BLOCK: Conviction ${conviction} < 40`);
      return this._blocked(ticker, conviction, rationale);
    }

    // ── 6. Trade type and parameters ──
    const action = isLong ? 'BUY_CALL' : 'BUY_PUT';
    const contractType = isLong ? 'CALL' : 'PUT';
    const deltaTargets = this._selectDeltaTargets(conviction, contractType, rationale);
    const sizeMultiplier = this._convictionToSize(conviction);

    // High compression squeezes produce more explosive moves — scale up
    const finalSize = compressionScore >= 80
      ? Math.min(2.0, sizeMultiplier * 1.25)
      : sizeMultiplier;

    // Timeframe-aware DTE: scalp → short DTE, swing → medium, position → long
    const intervalNum = parseInt(timeframe, 10) || 15;
    let dteTarget, dteMin, dteMax;
    if (intervalNum <= 5) {
      dteTarget = 5; dteMin = 3; dteMax = 7;
      rationale.push('DTE: Scalp timeframe (5min) → 3-7 DTE');
    } else if (intervalNum <= 15) {
      dteTarget = 10; dteMin = 7; dteMax = 14;
      rationale.push('DTE: Day trade timeframe (15min) → 7-14 DTE');
    } else if (intervalNum <= 60) {
      dteTarget = 21; dteMin = 14; dteMax = 30;
      rationale.push('DTE: Swing timeframe (1hr) → 14-30 DTE');
    } else {
      dteTarget = 35; dteMin = 21; dteMax = 45;
      rationale.push('DTE: Position timeframe (4hr+) → 21-45 DTE');
    }

    rationale.push(
      `SQUEEZE_PRO_APPROVED: compression=${compressionScore} conviction=${conviction} ` +
      `bars=${barsCompressed} vol_ratio=${volumeRatio.toFixed(2)} htf=${htfBias}`
    );
    rationale.push(`SIZE: ${finalSize}x (conviction=${conviction}${compressionScore >= 80 ? ', high-compression 1.25x boost' : ''})`);

    return {
      action,
      ticker,
      strike: null,
      expiry: null,
      delta_target: deltaTargets.target,
      delta_min: deltaTargets.min,
      delta_max: deltaTargets.max,
      dte_target: dteTarget,
      dte_min: dteMin,
      dte_max: dteMax,
      size_multiplier: finalSize,
      conviction_score: conviction,
      rationale,
      risk_parameters: {
        stop_level: stop,
        stop_source: 'SQUEEZE_PRO_SIGNAL',
        max_loss: risk * 100,
      },
      contractType,
    };
  }

  /**
   * Evaluate whether a macro bias flip should trigger exits on open positions.
   * Called from decision-router when MTF_BIAS updates.
   *
   * @param {Object} symbolState - The just-updated state
   * @param {string} userId
   * @returns {Promise<Object|null>} Exit decision if flip detected, null otherwise
   */
  async evaluateMacroFlipExit(symbolState, userId) {
    if (!symbolState.previous_macro_bias
      || symbolState.previous_macro_bias === 'NEUTRAL'
      || symbolState.macro_bias === 'NEUTRAL'
      || symbolState.previous_macro_bias === symbolState.macro_bias) {
      return null;
    }

    // Check for open positions on this symbol that conflict with new macro
    const result = await db.query(
      `SELECT * FROM sim_positions
       WHERE user_id = $1 AND symbol = $2 AND status = 'OPEN'`,
      [userId, symbolState.symbol]
    );

    if (result.rows.length === 0) return null;

    const exitPositions = [];
    for (const pos of result.rows) {
      const posIsLong = pos.contract_type === 'CALL' || pos.side === 'BUY';
      const newMacroLong = symbolState.macro_bias === 'BULLISH';

      if (posIsLong !== newMacroLong) {
        exitPositions.push(pos);
      }
    }

    if (exitPositions.length === 0) return null;

    const rationale = [
      `MACRO_FLIP_EXIT: Bias changed ${symbolState.previous_macro_bias} → ${symbolState.macro_bias}`,
      `${exitPositions.length} position(s) now counter-trend — triggering exit`,
    ];

    logger.warn(
      `[ENGINE] MACRO FLIP ${symbolState.symbol}: ${symbolState.previous_macro_bias} → ${symbolState.macro_bias} — ` +
      `exiting ${exitPositions.length} position(s)`,
      'trade-decision-engine'
    );

    return {
      action: 'EXIT',
      ticker: symbolState.symbol,
      rationale,
      positions: exitPositions,
      conviction_score: 0,
    };
  }
}

module.exports = new TradeDecisionEngine();
module.exports.TradeDecisionEngine = TradeDecisionEngine;
