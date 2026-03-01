'use strict';

const { mapToSignal, mapIndicatorToSignal, validateSignal } = require('./signal.contract');
const { detectIndicatorSource } = require('../webhooks/indicator-detector');
const safetyGuards = require('./safety-guards');
const strategyScorecardService = require('./strategy-scorecard.service');
const adaptiveGuards = require('./adaptive-guards');
const symbolStateService = require('./symbol-state.service');
const tradeDecisionEngine = require('./trade-decision-engine');
const optionsConstructor = require('./options-constructor.service');
const calibrationStore = require('./adaptive-intelligence/calibration-store.service');
const marketContext = require('./market-context.service');
const dataServiceProxy = require('../../services/dataServiceProxy');
const regimeIntegration = require('../portfolio/regime-integration');
const adaptiveParams = require('../strategy/adaptive-params');
const riskScaler = require('./risk-scaler');
const expectedMoveFilter = require('./expected-move-filter');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const { assertSimMode } = require('../../config/tradingMode');

/**
 * Sources that trigger trade evaluation.
 * All other sources update SymbolState only (context providers).
 */
const TRADE_TRIGGERS = new Set(['SIGNALS', 'STRAT', 'ORB', 'PIVOT_MB', 'UNKNOWN']);

/**
 * @typedef {Object} DecisionResult
 * @property {boolean} approved
 * @property {string} [reason]
 * @property {SimOrderIntent} [orderIntent]
 * @property {Object} [signal]
 * @property {string} [indicatorSource]
 * @property {boolean} [contextUpdateOnly] - True if webhook only updated state
 * @property {number} [convictionScore]
 * @property {Object} [tradeDecision] - Full engine output
 */

class DecisionRouter {
  /**
   * Evaluate a webhook payload and return an approval/rejection decision.
   *
   * Phase 0: Update SymbolState (every webhook, every time).
   * Non-trigger sources return immediately after state update.
   * Trigger sources (SIGNALS, ORB) proceed through the full pipeline.
   *
   * @param {Object} webhookPayload
   * @param {string} webhookEventId
   * @param {string} userId
   * @returns {Promise<DecisionResult>}
   */
  async evaluate(webhookPayload, webhookEventId, userId) {
    assertSimMode();

    const indicatorSource = detectIndicatorSource(webhookPayload);
    const isKnownIndicator = indicatorSource !== 'UNKNOWN';
    const symbol = (webhookPayload.ticker || webhookPayload.symbol || '').toUpperCase();

    // ── Phase 0: Update SymbolState with every webhook ──
    if (symbol && isKnownIndicator) {
      await symbolStateService.update(indicatorSource, webhookPayload, userId, symbol);
    }

    // ── Phase 0.5: Non-trigger sources → context update only ──
    // STRAT without actionable levels stays context-only.
    // V2 Plan Engine: only TRIGGERED / REVERSAL_IN_FORCE events are trade triggers.
    const isStratWithoutLevels = indicatorSource === 'STRAT'
      && !this._hasActionableStratLevels(webhookPayload);

    if (!TRADE_TRIGGERS.has(indicatorSource) || isStratWithoutLevels) {
      // MTF_BIAS flip may trigger exits on open positions
      if (indicatorSource === 'MTF_BIAS' && symbol) {
        const state = await symbolStateService.getState(userId, symbol);
        const exitDecision = await tradeDecisionEngine.evaluateMacroFlipExit(state, userId);

        if (exitDecision && exitDecision.positions.length > 0) {
          logger.warn(
            `[MACRO_FLIP] ${symbol}: ${state.previous_macro_bias} → ${state.macro_bias} — exiting ${exitDecision.positions.length} position(s)`,
            'decision-router'
          );

          // Estimate option exit prices so executor uses correct fill prices
          const intents = [];
          for (const pos of exitDecision.positions) {
            const exitPrice = await this._estimateOptionExitPrice(pos);
            intents.push({
              symbol,
              side: 'SELL',
              contractType: pos.contract_type || 'STOCK',
              strike: pos.strike,
              strikeShort: pos.strike_short,
              strikeLong: pos.strike_long,
              expiration: pos.expiration,
              quantity: pos.quantity || 1,
              strategy: 'MACRO_FLIP_EXIT',
              midPrice: exitPrice,
              indicatorSource,
              webhookEventId,
              positionId: pos.id,
            });
          }

          return {
            approved: true,
            signal: { symbol, action: 'CLOSE', strategy: 'MACRO_FLIP_EXIT', direction: null },
            indicatorSource,
            contextUpdateOnly: false,
            tradeDecision: exitDecision,
            orderIntents: intents,
            orderIntent: intents[0],
          };
        }
      }

      return {
        approved: false,
        reason: `[${indicatorSource}] Context update — state refreshed for ${symbol}`,
        indicatorSource,
        contextUpdateOnly: true,
      };
    }

    // ── Phase 1: Map webhook to signal ──
    let signal;
    if (isKnownIndicator) {
      const result = mapIndicatorToSignal(webhookPayload);
      if (!result.validation.valid) {
        logger.warn(
          `[${indicatorSource}] Indicator validation failed: ${result.validation.errors.join('; ')}`,
          'decision-router'
        );
        return {
          approved: false,
          reason: `[${indicatorSource}] Indicator validation failed: ${result.validation.errors.join('; ')}`,
          indicatorSource,
        };
      }
      signal = result.signal;
      logger.info(
        `[${indicatorSource}] ${signal.symbol} ${signal.direction} score=${signal.score ?? 'N/A'} strategy=${signal.strategy}`,
        'decision-router'
      );
    } else {
      signal = mapToSignal(webhookPayload);
    }

    const validation = validateSignal(signal);
    if (!validation.valid) {
      return {
        approved: false,
        reason: `Signal validation failed: ${validation.errors.join('; ')}`,
        signal,
        indicatorSource,
      };
    }

    // ── Phase 2: Account state + safety guards ──
    const accountState = await this._getOrCreateAccountState(userId);

    const safetyResult = await safetyGuards.evaluate(signal, accountState, userId);
    if (!safetyResult.safe) {
      await this._logRejection(userId, webhookEventId, signal, 'SAFETY_GUARD', safetyResult.violations.join('; '));
      return {
        approved: false,
        reason: `Safety guard violation: ${safetyResult.violations.join('; ')}`,
        signal,
        indicatorSource,
      };
    }

    if (signal.action !== 'CLOSE') {
      // Strategy gate
      const strategyGate = await strategyScorecardService.checkStrategyGate(userId, signal.strategy);
      if (!strategyGate.allowed) {
        await this._logRejection(userId, webhookEventId, signal, 'STRATEGY_GATE', strategyGate.reason);
        return { approved: false, reason: strategyGate.reason, signal, indicatorSource };
      }

      // Adaptive guards
      const adaptiveResult = await adaptiveGuards.evaluate(signal, accountState, userId);
      if (!adaptiveResult.allowed) {
        await this._logRejection(userId, webhookEventId, signal, 'ADAPTIVE_GUARD', adaptiveResult.reason);
        return { approved: false, reason: adaptiveResult.reason, signal, indicatorSource };
      }

      // ── Phase 2.5: Refresh chain data + volatility regime + market context ──
      const effectiveSymbol = signal.symbol || symbol;
      const [, volRegime, mktCtx] = await Promise.all([
        this._refreshChainData(effectiveSymbol, userId),
        this._fetchVolatilityRegime(effectiveSymbol),
        marketContext.getFullContext(effectiveSymbol),
      ]);

      // ── Phase 2.6: Adaptive portfolio config from regime ──
      const portfolioConfig = regimeIntegration.getAdaptivePortfolioConfig(volRegime);

      // ── Phase 3: Trade Decision Engine (deterministic) ──
      const symState = await symbolStateService.getState(userId, effectiveSymbol);
      if (volRegime) {
        symState.volatility_regime = volRegime.regime;
        symState.volatility_metrics = volRegime.metrics;
      }
      const tradeDecision = await tradeDecisionEngine.evaluate(signal, symState, accountState, userId, mktCtx);

      // Build regime overrides (existing clamping logic)
      const regimeResult = this._regimeOverrides(volRegime);
      const { _overridesApplied, _regime, _regimeRaw, _regimeClamped, ...regimeSafe } = regimeResult;

      // ── Phase 3.5: Adaptive strategy params from HV metrics ──
      const regimeMetrics = volRegime?.metrics || null;
      const baseStrategyConfig = {
        dte_target: tradeDecision.dte_target,
        dte_min: tradeDecision.dte_min,
        dte_max: tradeDecision.dte_max,
        delta_target: tradeDecision.delta_target,
        delta_min: tradeDecision.delta_min,
        delta_max: tradeDecision.delta_max,
        max_bid_ask_spread_pct: 0.08,
        takeProfitPct: 0.50,
      };
      const adaptedConfig = adaptiveParams.getAdaptiveStrategyParams(baseStrategyConfig, regimeMetrics);

      // Apply portfolio-level flags to adapted config
      if (portfolioConfig.allowLowerDelta) {
        adaptedConfig.min_delta = Math.max(0.30, (adaptedConfig.min_delta || 0.45) - 0.10);
      }
      if (portfolioConfig.tightenSpreadRequirement) {
        adaptedConfig.max_bid_ask_spread_pct = Math.max(0.03, (adaptedConfig.max_bid_ask_spread_pct || 0.08) - 0.02);
      }

      // ── Phase 3.6: Risk scaling from HV percentile ──
      const hvPercentile = regimeMetrics?.hvPercentile252 ?? null;
      const hvRiskResult = riskScaler.applyRiskScaling(tradeDecision.size_multiplier || 1, hvPercentile);
      const portfolioRiskMult = portfolioConfig.riskMultiplier || 1.0;
      const combinedRiskMultiplier = hvRiskResult.multiplier * portfolioRiskMult;
      const adjustedSizeMultiplier = (tradeDecision.size_multiplier || 1) * combinedRiskMultiplier;

      // ── Build versioned regime audit context (Phase 7) ──
      const regimeAuditContext = {
        regime: volRegime?.regime || null,
        hvPercentile: hvPercentile,
        atr14: regimeMetrics?.atr14 ?? null,
        atr30: regimeMetrics?.atr30 ?? null,
        analyticsVersion: volRegime?.analyticsVersion || null,
        overridesApplied: _overridesApplied || false,
        rawOverrides: _regimeRaw || null,
        clampedOverrides: _regimeClamped || null,
        portfolioConfig: {
          explosiveAllocation: portfolioConfig.explosiveAllocation,
          compoundingAllocation: portfolioConfig.compoundingAllocation,
          riskMultiplier: portfolioConfig.riskMultiplier,
          regimeSource: portfolioConfig.regimeSource,
        },
        adaptedStrategyParams: adaptedConfig.adjustments || [],
        riskScaling: {
          hvMultiplier: hvRiskResult.multiplier,
          portfolioMultiplier: portfolioRiskMult,
          combined: combinedRiskMultiplier,
        },
        adjustedSizeMultiplier,
        adjustedDTE: adaptedConfig.dte_target,
        adjustedDelta: adaptedConfig.delta_target,
        adjustedWeights: await this._getCalWeightsForAudit(userId),
        marketContext: mktCtx?.hasData ? {
          iv: mktCtx.iv ? { iv_rank: mktCtx.iv.iv_rank, iv_percentile: mktCtx.iv.iv_percentile, current_iv: mktCtx.iv.current_iv } : null,
          gex: mktCtx.gex ? { net_gex: mktCtx.gex.net_gex, flip_price: mktCtx.gex.flip_price } : null,
          flow: mktCtx.flow ? { sentiment: mktCtx.flow.sentiment, put_call_ratio: mktCtx.flow.put_call_ratio } : null,
        } : null,
      };

      await this._logIntelligenceVerdict(userId, webhookEventId, signal, tradeDecision, regimeAuditContext);

      if (tradeDecision.action === 'BLOCK') {
        const reason = tradeDecision.rationale.join('; ');
        await this._logRejection(userId, webhookEventId, signal, 'TRADE_ENGINE', reason);
        return {
          approved: false,
          reason,
          signal,
          indicatorSource,
          convictionScore: tradeDecision.conviction_score,
          tradeDecision,
        };
      }

      // ── Phase 4: Apply engine outputs to signal for options construction ──
      if (tradeDecision.contractType) {
        signal.contractType = null; // force construction with engine overrides
      }

      // Options constructor with engine + adaptive overrides
      if (optionsConstructor.needsConstruction(signal)) {
        const constructorEnabled = await optionsConstructor.isEnabled(userId);
        if (!constructorEnabled) {
          const reason = 'Options constructor disabled and no explicit contract type provided';
          await this._logRejection(userId, webhookEventId, signal, 'OPTIONS_CONSTRUCTOR', reason);
          return { approved: false, reason, signal, indicatorSource };
        }

        const engineOverrides = {
          contract_type: tradeDecision.contractType,
          target_delta: adaptedConfig.delta_target,
          min_delta: adaptedConfig.min_delta || tradeDecision.delta_min,
          max_delta: adaptedConfig.delta_max || tradeDecision.delta_max,
          target_dte: adaptedConfig.dte_target,
          min_dte: adaptedConfig.dte_min || tradeDecision.dte_min,
          max_dte: adaptedConfig.dte_max || tradeDecision.dte_max,
          min_open_interest: 100,
          min_volume: 10,
          max_bid_ask_spread_pct: adaptedConfig.max_bid_ask_spread_pct || 0.08,
          spread_width: 5,
          ...regimeSafe,
        };

        // Regime context for dynamic scoring weights (Phase 3)
        const regimeContext = volRegime ? {
          regime: volRegime.regime,
          hvPercentile: hvPercentile,
          atrRatio: (regimeMetrics?.atr14 && regimeMetrics?.atr30 > 0)
            ? regimeMetrics.atr14 / regimeMetrics.atr30
            : null,
        } : null;

        regimeAuditContext.finalParamsUsed = engineOverrides;
        if (regimeContext) {
          regimeAuditContext.adjustedWeights = optionsConstructor._getDynamicWeights(regimeContext);
        }

        const construction = await optionsConstructor.construct(signal, userId, engineOverrides, regimeContext);
        if (!construction.success) {
          await this._logRejection(userId, webhookEventId, signal, 'OPTIONS_CONSTRUCTOR', construction.reason);
          return {
            approved: false,
            reason: `Options construction failed: ${construction.reason}`,
            signal,
            indicatorSource,
          };
        }

        signal = construction.signal;
        logger.info(
          `[OPTIONS_CONSTRUCTOR] ${signal.symbol} → ${signal.contractType} strike=${signal.strike} exp=${signal.expiration}`,
          'decision-router'
        );

        // ── Phase 5: Expected move filter ──
        if (regimeMetrics?.atr14) {
          const targetPct = adaptedConfig.takeProfitReduction
            ? 0.50 - adaptedConfig.takeProfitReduction
            : 0.50;
          const emFilter = expectedMoveFilter.validateExpectedMove({
            atr14: regimeMetrics.atr14,
            delta: signal.delta,
            optionPremium: signal.midPrice,
            targetPctMove: targetPct,
          });
          regimeAuditContext.expectedMoveCheck = emFilter.details;
          if (!emFilter.pass) {
            await this._logRejection(userId, webhookEventId, signal, 'EXPECTED_MOVE', emFilter.reason);
            return {
              approved: false,
              reason: `Expected move filter: ${emFilter.reason}`,
              signal,
              indicatorSource,
            };
          }
        }
      }

      // ── Build approved order intent ──
      const resolvedContractType = signal.contractType || tradeDecision.contractType || 'STOCK';
      const isEntry = tradeDecision.action === 'BUY_CALL' || tradeDecision.action === 'BUY_PUT' || tradeDecision.action === 'SELL_SPREAD';
      const side = isEntry ? 'BUY' : (signal.action === 'BUY' ? 'BUY' : 'SELL');
      const baseQty = signal.quantity || 1;

      return {
        approved: true,
        signal,
        indicatorSource,
        convictionScore: tradeDecision.conviction_score,
        tradeDecision,
        orderIntent: {
          symbol: signal.symbol,
          side,
          contractType: resolvedContractType,
          strike: signal.strike,
          strikeShort: signal.strikeShort,
          strikeLong: signal.strikeLong,
          expiration: signal.expiration,
          quantity: Math.max(1, Math.round(baseQty * adjustedSizeMultiplier)),
          strategy: signal.strategy,
          limitPrice: signal.limitPrice,
          stopLoss: tradeDecision.risk_parameters.stop_level || signal.stopLoss,
          stopSource: tradeDecision.risk_parameters.stop_source || null,
          takeProfit: signal.takeProfit,
          bidPrice: signal.bidPrice,
          askPrice: signal.askPrice,
          midPrice: signal.midPrice,
          delta: signal.delta,
          indicatorSource,
          webhookEventId,
        },
      };
    }

    // ── Handle CLOSE action ──
    if (signal.action === 'CLOSE') {
      const position = await this._findOpenPosition(userId, signal);
      if (!position) {
        return {
          approved: false,
          reason: `No open position found for ${signal.symbol} ${signal.contractType}`,
          signal,
          indicatorSource,
        };
      }

      return {
        approved: true,
        signal,
        indicatorSource,
        orderIntent: {
          symbol: signal.symbol,
          side: 'SELL',
          contractType: signal.contractType || position.contract_type || 'STOCK',
          strike: position.strike,
          strikeShort: position.strike_short,
          strikeLong: position.strike_long,
          expiration: position.expiration,
          quantity: position.quantity,
          strategy: signal.strategy,
          bidPrice: signal.bidPrice,
          askPrice: signal.askPrice,
          midPrice: signal.midPrice,
          indicatorSource,
          webhookEventId,
          positionId: position.id,
        },
      };
    }

    return {
      approved: false,
      reason: `Unhandled signal action: ${signal.action}`,
      signal,
      indicatorSource,
    };
  }

  /**
   * Check if a STRAT payload has actionable trade levels.
   * V1: top-level entry/target/stop > 0
   * V2: TRIGGERED or REVERSAL_IN_FORCE event + plan.entry/stop/target1 > 0
   */
  _hasActionableStratLevels(payload) {
    // V1 format: flat top-level levels
    if (typeof payload.entry === 'number' && payload.entry > 0
      && typeof payload.target === 'number' && payload.target > 0
      && typeof payload.stop === 'number' && payload.stop > 0) {
      return true;
    }

    // V2 format: nested plan levels, gated by lifecycle event
    const event = (payload.event || '').toUpperCase();
    if ((event === 'TRIGGERED' || event === 'REVERSAL_IN_FORCE')
      && payload.plan && typeof payload.plan === 'object') {
      const planEntry = parseFloat(payload.plan.entry);
      const planStop = parseFloat(payload.plan.stop);
      const planTarget = parseFloat(payload.plan.target1);
      return planEntry > 0 && planStop > 0 && planTarget > 0;
    }

    return false;
  }

  /**
   * Estimate the current option price for a position being closed.
   * Tries live chain data first, falls back to intrinsic value.
   */
  async _estimateOptionExitPrice(position) {
    if (position.contract_type === 'STOCK') {
      const cached = await db.query(
        'SELECT price FROM price_cache WHERE symbol = $1',
        [position.symbol]
      );
      return cached.rows.length > 0 ? parseFloat(cached.rows[0].price) : null;
    }

    // Try live chain data
    try {
      const chainData = await dataServiceProxy.getOptionsChain(
        position.underlying_symbol || position.symbol,
        position.expiration
      );
      if (chainData?.data?.contracts) {
        const targetType = position.contract_type === 'PUT' ? 'put' : 'call';
        const match = chainData.data.contracts.find(c =>
          parseFloat(c.strike) === parseFloat(position.strike)
          && c.type?.toLowerCase() === targetType
        );
        if (match?.mid && match.mid > 0) return match.mid;
        if (match?.last && match.last > 0) return match.last;
      }
    } catch (_) {
      // Data service unavailable — fall back to intrinsic
    }

    // Fall back to intrinsic value from cached underlying price
    const cached = await db.query(
      'SELECT price FROM price_cache WHERE symbol = $1',
      [position.underlying_symbol || position.symbol]
    );
    if (cached.rows.length === 0) return parseFloat(position.avg_price);

    const underlyingPrice = parseFloat(cached.rows[0].price);
    const strike = parseFloat(position.strike);
    if (!strike || isNaN(strike)) return parseFloat(position.avg_price);

    if (position.contract_type === 'CALL') {
      return Math.max(0.01, underlyingPrice - strike);
    }
    if (position.contract_type === 'PUT') {
      return Math.max(0.01, strike - underlyingPrice);
    }
    if (position.contract_type === 'CREDIT_SPREAD') {
      const shortStrike = parseFloat(position.strike_short || position.strike);
      const longStrike = parseFloat(position.strike_long);
      if (!isNaN(shortStrike) && !isNaN(longStrike)) {
        const shortIntrinsic = Math.max(0, shortStrike - underlyingPrice);
        const longIntrinsic = Math.max(0, longStrike - underlyingPrice);
        return Math.max(0.01, shortIntrinsic - longIntrinsic);
      }
    }

    return parseFloat(position.avg_price);
  }

  async _getOrCreateAccountState(userId) {
    let result = await db.query(
      'SELECT * FROM sim_account_state WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      const initialBalance = parseFloat(process.env.SIM_INITIAL_BALANCE || '100000');
      result = await db.query(
        `INSERT INTO sim_account_state (user_id, cash_balance, buying_power, equity, peak_equity)
         VALUES ($1, $2, $2, $2, $2)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING *`,
        [userId, initialBalance]
      );
      if (result.rows.length === 0) {
        result = await db.query('SELECT * FROM sim_account_state WHERE user_id = $1', [userId]);
      }
    }

    return result.rows[0];
  }

  async _getCalWeightsForAudit(userId) {
    try {
      const weights = await calibrationStore.getActiveWeights(userId);
      if (!weights) return null;
      return Object.fromEntries(weights.map(w => [w.component_key, w.calibrated_weight]));
    } catch { return null; }
  }

  async _logIntelligenceVerdict(userId, webhookEventId, signal, tradeDecision, regimeContext = null) {
    try {
      await db.query(
        `INSERT INTO intelligence_verdicts
           (user_id, webhook_event_id, symbol, direction, strategy,
            intelligence_score, allowed, rejection_reason,
            confluence_count, signal_confidence, checks_detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          userId,
          webhookEventId,
          signal.symbol,
          signal.direction,
          signal.strategy,
          tradeDecision.conviction_score,
          tradeDecision.action !== 'BLOCK',
          tradeDecision.action === 'BLOCK' ? tradeDecision.rationale.join('; ') : null,
          null,
          signal.confidence ?? null,
          JSON.stringify({
            action: tradeDecision.action,
            rationale: tradeDecision.rationale,
            delta_target: tradeDecision.delta_target,
            dte_target: tradeDecision.dte_target,
            size_multiplier: tradeDecision.size_multiplier,
            risk_parameters: tradeDecision.risk_parameters,
            volatility_regime: regimeContext,
          }),
        ]
      );
    } catch (err) {
      logger.error(`Failed to log intelligence verdict: ${err.message}`, 'decision-router');
    }
  }

  async _logRejection(userId, webhookEventId, signal, gate, reason) {
    try {
      await db.query(
        `INSERT INTO signal_rejections (user_id, webhook_event_id, symbol, strategy, action, reason, gate, raw_signal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, webhookEventId, signal.symbol, signal.strategy, signal.action, reason, gate, JSON.stringify(signal)]
      );
    } catch (err) {
      logger.error(`Failed to log rejection: ${err.message}`, 'decision-router');
    }
  }

  /**
   * Fetch fresh chain data from the data-service and update symbol_state
   * so the trade decision engine has current options liquidity info.
   * Skips refresh if chain data is still fresh (< 5 min old).
   */
  async _refreshChainData(symbol, userId) {
    const CHAIN_REFRESH_TTL_MS = parseInt(process.env.SIM_CHAIN_REFRESH_TTL_MS || '300000', 10); // 5 min
    try {
      const currentState = await symbolStateService.getState(userId, symbol);
      if (currentState.chain_updated_at) {
        const ageMs = Date.now() - new Date(currentState.chain_updated_at).getTime();
        if (ageMs < CHAIN_REFRESH_TTL_MS) {
          logger.info(`[CHAIN_REFRESH] ${symbol}: chain data fresh (${Math.round(ageMs / 1000)}s old), skipping`, 'decision-router');
          return;
        }
      }

      const chainData = await dataServiceProxy.getOptionsChain(symbol);
      const contracts = chainData?.data?.contracts || [];
      if (contracts.length > 0) {
        await symbolStateService.update('CHAIN_SNAPSHOT', {
          ticker: symbol,
          contracts,
          iv_percentile: chainData.data.iv_percentile || null,
        }, userId, symbol);
        logger.info(`[CHAIN_REFRESH] ${symbol}: refreshed ${contracts.length} contracts from data-service`, 'decision-router');
      } else {
        logger.warn(`[CHAIN_REFRESH] ${symbol}: data-service returned no contracts`, 'decision-router');
      }
    } catch (err) {
      logger.warn(`[CHAIN_REFRESH] ${symbol}: data-service unavailable (${err.message}) — using cached state`, 'decision-router');
    }
  }

  /**
   * Regime-aware parameter adjustments for options construction.
   * All adjustments are clamped to global safety caps so regime logic
   * can never expand risk beyond base configuration.
   */
  _regimeOverrides(volRegime) {
    const GLOBAL_CAPS = {
      MAX_DTE: parseInt(process.env.SIM_GLOBAL_MAX_DTE || '60', 10),
      MIN_DTE: 0,
      MAX_SPREAD_PCT: parseFloat(process.env.SIM_GLOBAL_MAX_SPREAD_PCT || '0.15'),
      MAX_SPREAD_WIDTH: parseFloat(process.env.SIM_GLOBAL_MAX_SPREAD_WIDTH || '15'),
      MIN_SPREAD_WIDTH: 1,
    };

    if (!volRegime?.regime) return { _overridesApplied: false };

    let raw = {};
    switch (volRegime.regime) {
      case 'HIGH_VOL_EXPANSION':
        raw = {
          max_bid_ask_spread_pct: 0.12,
          min_dte: 14,
          target_dte: 30,
          spread_width: 10,
        };
        break;
      case 'LOW_VOL_CHOP':
        raw = {
          max_bid_ask_spread_pct: 0.06,
          target_dte: 7,
          max_dte: 21,
          spread_width: 2.5,
        };
        break;
      default:
        return { _overridesApplied: false };
    }

    const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

    const clamped = {};
    if (raw.target_dte !== undefined)
      clamped.target_dte = clamp(raw.target_dte, GLOBAL_CAPS.MIN_DTE, GLOBAL_CAPS.MAX_DTE);
    if (raw.min_dte !== undefined)
      clamped.min_dte = clamp(raw.min_dte, GLOBAL_CAPS.MIN_DTE, GLOBAL_CAPS.MAX_DTE);
    if (raw.max_dte !== undefined)
      clamped.max_dte = clamp(raw.max_dte, GLOBAL_CAPS.MIN_DTE, GLOBAL_CAPS.MAX_DTE);
    if (raw.max_bid_ask_spread_pct !== undefined)
      clamped.max_bid_ask_spread_pct = clamp(raw.max_bid_ask_spread_pct, 0.01, GLOBAL_CAPS.MAX_SPREAD_PCT);
    if (raw.spread_width !== undefined)
      clamped.spread_width = clamp(raw.spread_width, GLOBAL_CAPS.MIN_SPREAD_WIDTH, GLOBAL_CAPS.MAX_SPREAD_WIDTH);

    logger.info(
      `[REGIME_OVERRIDE] ${volRegime.symbol}: regime=${volRegime.regime} raw=${JSON.stringify(raw)} clamped=${JSON.stringify(clamped)}`,
      'decision-router'
    );

    return {
      ...clamped,
      _overridesApplied: true,
      _regime: volRegime.regime,
      _regimeRaw: raw,
      _regimeClamped: clamped,
    };
  }

  /**
   * Fetch the volatility regime from the data service.
   * Tries the v1 historical endpoint first (comprehensive, fresh),
   * then falls back to the legacy /api/regime endpoint.
   * Returns null on failure — decision pipeline continues without regime context.
   */
  async _fetchVolatilityRegime(symbol) {
    // Try v1 historical endpoint first
    try {
      const result = await dataServiceProxy.getHistoricalRegime(symbol);
      if (result?.regime) {
        logger.info(
          `[VOL_REGIME] ${symbol}: regime=${result.regime} hvPct=${result.metrics?.hvPercentile252?.toFixed(2) ?? 'N/A'} (source=v1/historical)`,
          'decision-router'
        );
        return { ...result, _source: 'v1_historical' };
      }
    } catch (err) {
      logger.info(
        `[VOL_REGIME] ${symbol}: v1 historical unavailable (${err.message}), trying legacy`,
        'decision-router'
      );
    }

    // Fall back to legacy /api/regime endpoint
    try {
      const result = await dataServiceProxy.getVolatilityRegime(symbol);
      if (result?.regime) {
        logger.info(
          `[VOL_REGIME] ${symbol}: regime=${result.regime} hvPct=${result.metrics?.hvPercentile252?.toFixed(2) ?? 'N/A'} (source=legacy)`,
          'decision-router'
        );
        return { ...result, _source: 'legacy' };
      }
      return null;
    } catch (err) {
      logger.warn(
        `[REGIME_UNAVAILABLE] ${symbol}: all regime endpoints unavailable (${err.message}) — proceeding with base config`,
        'decision-router'
      );
      return null;
    }
  }

  async _findOpenPosition(userId, signal) {
    const conditions = ['user_id = $1', 'status = $2', 'underlying_symbol = $3'];
    const params = [userId, 'OPEN', signal.symbol];
    let idx = 4;

    if (signal.contractType !== 'STOCK') {
      conditions.push(`contract_type = $${idx++}`);
      params.push(signal.contractType);
    }
    if (signal.strike) {
      conditions.push(`strike = $${idx++}`);
      params.push(signal.strike);
    }
    if (signal.expiration) {
      conditions.push(`expiration = $${idx++}`);
      params.push(signal.expiration);
    }

    const result = await db.query(
      `SELECT * FROM sim_positions WHERE ${conditions.join(' AND ')} ORDER BY opened_at ASC LIMIT 1`,
      params
    );

    return result.rows[0] || null;
  }
}

module.exports = new DecisionRouter();
module.exports.DecisionRouter = DecisionRouter;
