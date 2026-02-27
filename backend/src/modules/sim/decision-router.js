'use strict';

const { mapToSignal, mapIndicatorToSignal, validateSignal } = require('./signal.contract');
const { detectIndicatorSource } = require('../webhooks/indicator-detector');
const safetyGuards = require('./safety-guards');
const strategyScorecardService = require('./strategy-scorecard.service');
const adaptiveGuards = require('./adaptive-guards');
const symbolStateService = require('./symbol-state.service');
const tradeDecisionEngine = require('./trade-decision-engine');
const optionsConstructor = require('./options-constructor.service');
const dataServiceProxy = require('../../services/dataServiceProxy');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const { assertSimMode } = require('../../config/tradingMode');

/**
 * Sources that trigger trade evaluation.
 * All other sources update SymbolState only (context providers).
 */
const TRADE_TRIGGERS = new Set(['SIGNALS', 'STRAT', 'ORB', 'UNKNOWN']);

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

      // ── Phase 3: Trade Decision Engine (deterministic, replaces fuzzy scoring) ──
      const effectiveSymbol = signal.symbol || symbol;
      const symState = await symbolStateService.getState(userId, effectiveSymbol);
      const tradeDecision = await tradeDecisionEngine.evaluate(signal, symState, accountState, userId);

      await this._logIntelligenceVerdict(userId, webhookEventId, signal, tradeDecision);

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

      // Options constructor with engine overrides
      if (optionsConstructor.needsConstruction(signal)) {
        const constructorEnabled = await optionsConstructor.isEnabled(userId);
        if (!constructorEnabled) {
          const reason = 'Options constructor disabled and no explicit contract type provided';
          await this._logRejection(userId, webhookEventId, signal, 'OPTIONS_CONSTRUCTOR', reason);
          return { approved: false, reason, signal, indicatorSource };
        }

        const engineOverrides = {
          contract_type: tradeDecision.contractType,
          target_delta: tradeDecision.delta_target,
          min_delta: tradeDecision.delta_min,
          max_delta: tradeDecision.delta_max,
          target_dte: tradeDecision.dte_target,
          min_dte: tradeDecision.dte_min,
          max_dte: tradeDecision.dte_max,
          min_open_interest: 100,
          min_volume: 10,
          max_bid_ask_spread_pct: 0.08,
          spread_width: 5,
        };

        const construction = await optionsConstructor.construct(signal, userId, engineOverrides);
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
      }

      // ── Build approved order intent ──
      // For options entries, the side is always BUY (you buy calls or puts).
      // The signal direction (long/short) determines CALL vs PUT, not BUY vs SELL.
      const resolvedContractType = signal.contractType || tradeDecision.contractType || 'STOCK';
      const isEntry = tradeDecision.action === 'BUY_CALL' || tradeDecision.action === 'BUY_PUT' || tradeDecision.action === 'SELL_SPREAD';
      const side = isEntry ? 'BUY' : (signal.action === 'BUY' ? 'BUY' : 'SELL');
      const sizeMultiplier = tradeDecision.size_multiplier || 1;
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
          quantity: Math.max(1, Math.round(baseQty * sizeMultiplier)),
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

  async _logIntelligenceVerdict(userId, webhookEventId, signal, tradeDecision) {
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

  async _findOpenPosition(userId, signal) {
    const conditions = ['user_id = $1', 'status = $2', 'symbol = $3'];
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
      `SELECT * FROM sim_positions WHERE ${conditions.join(' AND ')} ORDER BY opened_at DESC LIMIT 1`,
      params
    );

    return result.rows[0] || null;
  }
}

module.exports = new DecisionRouter();
module.exports.DecisionRouter = DecisionRouter;
