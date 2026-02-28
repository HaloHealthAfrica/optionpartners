'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');
const calibrationStore = require('./adaptive-intelligence/calibration-store.service');

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
   * @returns {Promise<TradeDecision>}
   */
  async evaluate(signal, symbolState, accountState, userId) {
    const rationale = [];
    const ticker = signal.symbol || symbolState.symbol;

    // ── Part 8: Fail-closed checks (run first — reject before any analysis) ──
    const failClosed = this._checkFailClosed(symbolState, accountState, rationale);
    if (failClosed) return failClosed;

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

    // ── Part 3: Conviction calculation (with optional calibrated weights) ──
    let calibratedWeights = null;
    try {
      calibratedWeights = await calibrationStore.getWeightMap(userId);
    } catch (_) { /* proceed with static weights */ }
    let conviction = this._computeConviction(signal, symbolState, rationale, calibratedWeights);

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
    const tradeType = this._determineTradeType(signal, symbolState, conviction, rationale);

    // ── Part 5: Delta target selection ──
    const deltaTargets = this._selectDeltaTargets(conviction, tradeType, rationale);

    // ── Part 6: DTE logic ──
    const dteTargets = this._selectDteRange(symbolState, isOrbTrigger, rationale);

    // ── Part 7: Exit / risk parameters ──
    const riskParams = this._computeRiskParameters(signal, symbolState, entrySignal, rationale);

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

  _checkFailClosed(state, accountState, rationale) {
    const ticker = state.symbol;
    const STATE_TTL_MS = parseInt(process.env.SIM_STATE_TTL_MS || '1800000', 10); // 30 min default

    // Chain data validation
    const requireChain = process.env.SIM_REQUIRE_CHAIN_DATA !== 'false';
    if (state.chain_updated_at && !state.chain_ok) {
      rationale.push('FAIL_CLOSED: Chain data present but no valid contracts');
      return this._blocked(ticker, 0, rationale);
    }
    if (!state.chain_updated_at) {
      if (requireChain) {
        rationale.push('FAIL_CLOSED: No chain data received — cannot validate options liquidity');
        return this._blocked(ticker, 0, rationale);
      }
      rationale.push('WARN: No chain data — proceeding without options liquidity validation');
    }

    // Chain staleness check
    if (state.chain_updated_at) {
      const chainAgeMs = Date.now() - new Date(state.chain_updated_at).getTime();
      if (chainAgeMs > STATE_TTL_MS) {
        if (requireChain) {
          rationale.push(`FAIL_CLOSED: Chain data stale (${Math.round(chainAgeMs / 1000)}s old, max ${STATE_TTL_MS / 1000}s)`);
          return this._blocked(ticker, 0, rationale);
        }
        rationale.push(`WARN: Chain data stale (${Math.round(chainAgeMs / 1000)}s) — proceeding anyway`);
      }
    }

    // Price data required (soft-gate: signal itself often carries price)
    if (!state.price_updated_at && !state.last_price) {
      rationale.push('WARN: No dedicated price feed — will use signal-embedded price');
    }
    if (state.price_updated_at) {
      const priceAgeMs = Date.now() - new Date(state.price_updated_at).getTime();
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

    if (state.bid_ask_spread_pct != null && state.bid_ask_spread_pct > 0.10) {
      rationale.push(`FAIL_CLOSED: Bid-ask spread ${(state.bid_ask_spread_pct * 100).toFixed(1)}% exceeds 10% max`);
      return this._blocked(ticker, 0, rationale);
    }

    if (accountState) {
      const dailyLoss = Math.abs(Math.min(0, parseFloat(accountState.daily_pnl || 0)));
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

    const signalDir = entrySignal.direction;
    if (signalDir && state.macro_bias !== 'NEUTRAL') {
      const macroDirLong = state.macro_bias === 'BULLISH';
      const signalIsLong = signalDir === 'long';
      if (macroDirLong !== signalIsLong) {
        failures.push(`macro_bias=${state.macro_bias} conflicts with signal direction=${signalDir}`);
      }
    }

    if (failures.length > 0) {
      rationale.push(`PRECONDITION_FAIL: ${failures.join('; ')}`);
      return { valid: false, conviction: 0 };
    }

    rationale.push('PRECONDITIONS: All SIGNALS checks passed');
    return { valid: true, conviction: entrySignal.confidence || 0 };
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
    const now = new Date();
    const utcMonth = now.getUTCMonth();
    let isDST = utcMonth > 2 && utcMonth < 10;
    if (utcMonth === 2) {
      const secSun = 14 - new Date(now.getUTCFullYear(), 2, 1).getDay();
      isDST = now.getUTCDate() > secSun || (now.getUTCDate() === secSun && now.getUTCHours() >= 7);
    } else if (utcMonth === 10) {
      const firstSun = 7 - new Date(now.getUTCFullYear(), 10, 1).getDay();
      isDST = now.getUTCDate() < firstSun || (now.getUTCDate() === firstSun && now.getUTCHours() < 6);
    }
    const etMs = now.getTime() + (isDST ? -4 : -5) * 3600000;
    const etDate = new Date(etMs);
    const etHour = etDate.getUTCHours();
    const etMinute = etDate.getUTCMinutes();
    const etTime = etHour * 60 + etMinute;
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

    const signalDir = entrySignal.direction;
    if (signalDir && state.macro_bias !== 'NEUTRAL' && state.macro_bias) {
      const macroDirLong = state.macro_bias === 'BULLISH';
      const signalIsLong = signalDir === 'long';
      if (macroDirLong !== signalIsLong) {
        failures.push(`macro_bias=${state.macro_bias} conflicts with STRAT direction=${signalDir}`);
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
    return { valid: true, conviction: entrySignal.confidence || 75 };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 2 — MACRO RULES (MTF_BIAS authority)
  // ═══════════════════════════════════════════════════════════════════

  _applyMacroRules(signal, state, rationale) {
    const dir = signal.direction || state.latest_entry_signal?.direction;
    const isLong = dir === 'long';

    // Regime-based blocks
    if (state.regime === 'TREND' && state.macro_strength >= 65) {
      rationale.push(`MACRO: regime=TREND macro_strength=${state.macro_strength} — trend trades only`);
    }

    if (state.regime === 'CHOP') {
      rationale.push('MACRO: regime=CHOP — breakout trades blocked, prefer spreads');
    }

    // Room-to-move blocks
    if (isLong && state.room_to_resistance === 'LOW') {
      rationale.push('MACRO_PENALTY: room_to_resistance=LOW — CALL conviction -15');
    }

    if (!isLong && state.room_to_support === 'LOW') {
      rationale.push('MACRO_PENALTY: room_to_support=LOW — PUT conviction -15');
    }

    return { blocked: false };
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

  _computeConviction(signal, state, rationale, calibratedWeights = null) {
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

    // -Room penalty (low room to move in trade direction)
    if (dir === 'long' && state.room_to_resistance === 'LOW') {
      conviction -= 15;
      rationale.push('CONVICTION -15: room_to_resistance=LOW');
    } else if (dir === 'short' && state.room_to_support === 'LOW') {
      conviction -= 15;
      rationale.push('CONVICTION -15: room_to_support=LOW');
    }

    // +Macro strength modifier (macro_strength / 10)
    if (state.macro_strength > 0) {
      const macroBonus = Math.round(state.macro_strength / 10);
      conviction += macroBonus;
      rationale.push(`CONVICTION +${macroBonus}: macro_strength=${state.macro_strength}`);
    }

    // -Regime mismatch penalties
    if (state.regime === 'CHOP') {
      conviction -= 10;
      rationale.push('CONVICTION -10: CHOP regime penalty');
    } else if (state.regime === 'CONTRACTION') {
      conviction -= 5;
      rationale.push('CONVICTION -5: CONTRACTION regime penalty');
    }

    conviction = Math.max(0, Math.round(conviction));
    rationale.push(`CONVICTION_FINAL: ${conviction}`);
    return conviction;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 4 — TRADE TYPE DECISION
  // ═══════════════════════════════════════════════════════════════════

  _determineTradeType(signal, state, conviction, rationale) {
    const dir = signal.direction || state.latest_entry_signal?.direction;
    const iv = state.iv_percentile;

    // CREDIT SPREAD conditions
    if (iv != null && iv >= 70 && state.regime === 'CHOP' && conviction >= 60 && conviction < 80) {
      rationale.push(`TRADE_TYPE: CREDIT_SPREAD (IV=${iv}% ≥ 70, regime=CHOP, moderate conviction)`);
      return 'CREDIT_SPREAD';
    }
    if (iv != null && iv >= 80) {
      rationale.push(`TRADE_TYPE: CREDIT_SPREAD (IV=${iv}% ≥ 80 — prefer spreads over naked)`);
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

  _selectDeltaTargets(conviction, tradeType, rationale) {
    if (tradeType === 'CREDIT_SPREAD') {
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

    // Flow-based OTM shift for high-leverage plays
    // (handled via size multiplier instead of delta shift for safety)

    return { target, min, max };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 6 — DTE LOGIC
  // ═══════════════════════════════════════════════════════════════════

  _selectDteRange(state, isOrb, rationale) {
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

    // Default swing: 14-30 DTE
    rationale.push('DTE: Default swing → 14-30 DTE');
    return { target: 21, min: 14, max: 30 };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Part 7 — EXIT / RISK PARAMETERS
  // ═══════════════════════════════════════════════════════════════════

  _computeRiskParameters(signal, state, entrySignal, rationale) {
    let stopLevel = null;
    let stopSource = null;
    let maxLoss = null;

    // Stop hierarchy:
    // 1. Structure invalidation (from MTF risk_context)
    const macroRaw = state.latest_macro_raw;
    const structureStop = macroRaw?.riskContext?.invalidation?.level;
    if (structureStop) {
      stopLevel = parseFloat(structureStop);
      stopSource = 'STRUCTURE_INVALIDATION';
      rationale.push(`STOP: Structure invalidation from MTF @ ${stopLevel}`);
    }

    // 2. SIGNALS stop_loss
    if (!stopLevel && entrySignal?.stop_loss) {
      stopLevel = entrySignal.stop_loss;
      stopSource = 'SIGNALS_STOP_LOSS';
      rationale.push(`STOP: SIGNALS stop_loss @ ${stopLevel}`);
    }

    // 3. ATR trailing (2x ATR) — prefer strat plan ATR when available
    const effectiveAtr = state.latest_strat_signal?.atr || state.atr;
    if (!stopLevel && effectiveAtr && state.last_price) {
      const dir = signal.direction || entrySignal?.direction;
      const atrMultiple = 2;
      stopLevel = dir === 'long'
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

    return { stop_level: stopLevel, stop_source: stopSource, max_loss: maxLoss };
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
