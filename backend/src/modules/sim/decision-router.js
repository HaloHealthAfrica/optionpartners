'use strict';

const { mapToSignal, mapIndicatorToSignal, validateSignal } = require('./signal.contract');
const { detectIndicatorSource } = require('../webhooks/indicator-detector');
const safetyGuards = require('./safety-guards');
const strategyScorecardService = require('./strategy-scorecard.service');
const adaptiveGuards = require('./adaptive-guards');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const { assertSimMode } = require('../../config/tradingMode');

/**
 * @typedef {Object} SimOrderIntent
 * @property {string} symbol
 * @property {'BUY'|'SELL'} side
 * @property {'CALL'|'PUT'|'CREDIT_SPREAD'|'STOCK'} contractType
 * @property {number} [strike]
 * @property {number} [strikeShort]
 * @property {number} [strikeLong]
 * @property {string} [expiration]
 * @property {number} quantity
 * @property {string} strategy
 * @property {number} [limitPrice]
 * @property {number} [stopLoss]
 * @property {number} [takeProfit]
 * @property {number} [bidPrice]
 * @property {number} [askPrice]
 * @property {number} [midPrice]
 * @property {number} [delta]
 * @property {string} [indicatorSource]
 * @property {string} webhookEventId
 */

/**
 * @typedef {Object} DecisionResult
 * @property {boolean} approved
 * @property {string} [reason]
 * @property {SimOrderIntent} [orderIntent]
 * @property {Object} [signal] - The mapped internal signal
 * @property {string} [indicatorSource] - Which indicator produced this
 */

class DecisionRouter {
  /**
   * Evaluate a webhook payload and return an approval/rejection decision.
   * Deterministic given same inputs.
   *
   * Routes through the indicator-aware pipeline for known sources,
   * falls back to the legacy generic mapper for unknown payloads.
   *
   * @param {Object} webhookPayload - Raw payload from webhook_events
   * @param {string} webhookEventId
   * @param {string} userId
   * @returns {Promise<DecisionResult>}
   */
  async evaluate(webhookPayload, webhookEventId, userId) {
    assertSimMode();

    const indicatorSource = detectIndicatorSource(webhookPayload);
    const isKnownIndicator = indicatorSource !== 'UNKNOWN';

    let signal;
    let indicatorValidation;

    if (isKnownIndicator) {
      const result = mapIndicatorToSignal(webhookPayload);
      indicatorValidation = result.validation;

      if (!indicatorValidation.valid) {
        logger.warn(
          `[${indicatorSource}] Indicator validation failed: ${indicatorValidation.errors.join('; ')}`,
          'decision-router'
        );
        return {
          approved: false,
          reason: `[${indicatorSource}] Indicator validation failed: ${indicatorValidation.errors.join('; ')}`,
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

    // Validate the mapped signal
    const validation = validateSignal(signal);
    if (!validation.valid) {
      return {
        approved: false,
        reason: `Signal validation failed: ${validation.errors.join('; ')}`,
        signal,
        indicatorSource,
      };
    }

    // Get account state for safety checks
    const accountState = await this._getOrCreateAccountState(userId);

    // Run safety guards
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

    // Strategy Gate: block underperforming strategies (Phase 1)
    if (signal.action !== 'CLOSE') {
      const strategyGate = await strategyScorecardService.checkStrategyGate(userId, signal.strategy);
      if (!strategyGate.allowed) {
        await this._logRejection(userId, webhookEventId, signal, 'STRATEGY_GATE', strategyGate.reason);
        return {
          approved: false,
          reason: strategyGate.reason,
          signal,
          indicatorSource,
        };
      }

      // Adaptive Guards: cooldowns, correlation, drawdown throttle (Phase 4)
      const adaptiveResult = await adaptiveGuards.evaluate(signal, accountState, userId);
      if (!adaptiveResult.allowed) {
        await this._logRejection(userId, webhookEventId, signal, 'ADAPTIVE_GUARD', adaptiveResult.reason);
        return {
          approved: false,
          reason: adaptiveResult.reason,
          signal,
          indicatorSource,
        };
      }
    }

    // Handle CLOSE action
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
          contractType: signal.contractType,
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

    // Build order intent for BUY/SELL
    const side = signal.action === 'BUY' ? 'BUY' : 'SELL';

    return {
      approved: true,
      signal,
      indicatorSource,
      orderIntent: {
        symbol: signal.symbol,
        side,
        contractType: signal.contractType,
        strike: signal.strike,
        strikeShort: signal.strikeShort,
        strikeLong: signal.strikeLong,
        expiration: signal.expiration,
        quantity: signal.quantity,
        strategy: signal.strategy,
        limitPrice: signal.limitPrice,
        stopLoss: signal.stopLoss,
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
    const conditions = [
      'user_id = $1',
      'status = $2',
      'symbol = $3',
    ];
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
