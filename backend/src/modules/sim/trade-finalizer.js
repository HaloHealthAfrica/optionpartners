'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const ledgerService = require('./ledger.service');
const strategyScorecardService = require('./strategy-scorecard.service');
const adaptiveGuards = require('./adaptive-guards');
const calibrationStore = require('./adaptive-intelligence/calibration-store.service');
const convictionCalibrator = require('./adaptive-intelligence/conviction-calibrator.service');
const autoInsightService = require('./adaptive-intelligence/auto-insight.service');
const simEventBus = require('./sim-event-bus');
const Sentry = require('@sentry/node');

const CONTRACT_MULTIPLIER = 100;

class TradeFinalizerService {
  /**
   * Finalize a closed position into a sim_trade record for analytics.
   * Called when a position transitions from OPEN to CLOSED.
   *
   * @param {Object} position - The closed sim_position row
   * @param {number} exitPrice - The fill price used to close
   * @param {string} userId
   * @returns {Promise<Object>} The created sim_trade record
   */
  async finalize(position, exitPrice, userId) {
    const entryPrice = parseFloat(position.avg_price);
    const multiplier = position.contract_type === 'STOCK' ? 1 : CONTRACT_MULTIPLIER;
    const quantity = position.quantity;

    // Calculate realized PnL
    let pnl;
    if (position.contract_type === 'CREDIT_SPREAD') {
      pnl = (entryPrice - exitPrice) * quantity * multiplier;
    } else {
      pnl = (exitPrice - entryPrice) * quantity * multiplier;
    }

    // P&L percent: for credit spreads use margin (capital at risk), not credit received
    let capitalBase;
    if (position.contract_type === 'CREDIT_SPREAD') {
      const spreadWidth = Math.abs(
        (parseFloat(position.strike_short) || 0) - (parseFloat(position.strike_long) || 0)
      );
      capitalBase = (spreadWidth - entryPrice) * quantity * multiplier;
    } else {
      capitalBase = entryPrice * quantity * multiplier;
    }
    const pnlPercent = capitalBase !== 0 ? (pnl / capitalBase) * 100 : 0;

    // R-multiple (if stop loss is available from the order intent)
    const rMultiple = await this._calculateRMultiple(position, pnl);

    // DTE at entry
    const dteAtEntry = position.expiration
      ? Math.ceil((new Date(position.expiration) - new Date(position.opened_at)) / (1000 * 60 * 60 * 24))
      : null;

    // Commission total from fills: match by the position's webhook_event_id (entry)
    // and any order whose intent_payload references this position_id (exit)
    const commissionResult = await db.query(
      `SELECT COALESCE(SUM(f.commission), 0) as total_commission
       FROM sim_fills f
       JOIN sim_orders o ON f.order_id = o.id
       WHERE o.webhook_event_id = $1
          OR o.intent_payload->>'positionId' = $2`,
      [position.webhook_event_id, position.id]
    );
    const commissionTotal = parseFloat(commissionResult.rows[0].total_commission);

    // Determine side
    const side = position.contract_type === 'CREDIT_SPREAD' ? 'short' : 'long';

    const id = uuidv4();
    const result = await db.query(
      `INSERT INTO sim_trades (
        id, user_id, position_id, symbol, underlying_symbol, contract_type,
        side, strategy, strike, strike_short, strike_long, expiration,
        entry_price, exit_price, quantity, contract_multiplier,
        entry_time, exit_time, pnl, pnl_percent, r_multiple,
        commission_total, dte_at_entry, delta_at_entry,
        is_sim, webhook_event_id, stop_source, exit_reason
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, TRUE, $25, $26, $27
      ) RETURNING *`,
      [
        id, userId, position.id, position.symbol, position.underlying_symbol,
        position.contract_type, side, position.strategy,
        position.strike, position.strike_short, position.strike_long, position.expiration,
        entryPrice, exitPrice, quantity, multiplier,
        position.opened_at, position.closed_at || new Date(),
        pnl, pnlPercent, rMultiple,
        commissionTotal, dteAtEntry, position.delta_at_entry,
        position.webhook_event_id, position.stop_source || null, position.exit_reason || null,
      ]
    );

    const trade = result.rows[0];

    // Emit real-time event for SSE clients
    simEventBus.sendToUser(userId, 'trade:finalized', {
      id: trade.id,
      symbol: trade.symbol,
      contractType: trade.contract_type,
      strategy: trade.strategy,
      side: trade.side,
      pnl: parseFloat(trade.pnl),
      pnlPercent: parseFloat(trade.pnl_percent),
      entryPrice: parseFloat(trade.entry_price),
      exitPrice: parseFloat(trade.exit_price),
      exitReason: trade.exit_reason,
      rMultiple: trade.r_multiple ? parseFloat(trade.r_multiple) : null,
      timestamp: new Date().toISOString(),
    });
    simEventBus.emit('trade:finalized', { userId, trade });

    // Take an equity snapshot after each trade closes
    await ledgerService.takeEquitySnapshot(userId);

    // Recalculate strategy scorecard after each trade (Phase 1)
    // Update adaptive cooldowns (Phase 4)
    if (position.strategy) {
      try {
        await strategyScorecardService.recalculate(userId, position.strategy);
        await adaptiveGuards.recordTradeResult(userId, position.strategy, pnl);
      } catch (err) {
        logger.error(`Intelligence layer post-trade update failed: ${err.message}`, 'sim-finalizer');
        Sentry.captureException(err, { tags: { module: 'sim-finalizer' } });
      }
    }

    // Increment calibration trade counter and auto-calibrate if enabled + threshold met
    try {
      const calStatus = await calibrationStore.incrementTradeCount(userId);
      if (calStatus.thresholdReached && calStatus.autoEnabled) {
        const calResult = await convictionCalibrator.calibrate(userId, { lookbackDays: 90, minSampleSize: 10 });
        if (calResult.totalTrades >= 25) {
          await calibrationStore.applyCalibration(userId, calResult.components, 'AUTO');
          logger.info(`[AUTO_CALIBRATION] Applied after ${calStatus.count} trades for user ${userId}`, 'sim-finalizer');
        }
      }

      // Check for auto-insight trigger (runs in background, non-blocking)
      autoInsightService.checkAndGenerate(userId, calStatus.count, trade).catch(err => {
        logger.error(`Auto-insight check failed: ${err.message}`, 'sim-finalizer');
      });
    } catch (err) {
      logger.error(`Calibration counter update failed: ${err.message}`, 'sim-finalizer');
      Sentry.captureException(err, { tags: { module: 'sim-finalizer' } });
    }

    logger.info(
      `Trade finalized: ${position.symbol} ${position.contract_type} PnL=$${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`,
      'sim-finalizer'
    );

    return trade;
  }

  async _calculateRMultiple(position, pnl) {
    const multiplier = position.contract_type === 'STOCK' ? 1 : CONTRACT_MULTIPLIER;

    // Credit spreads: risk = max loss = (spreadWidth - credit) * multiplier * qty
    if (position.contract_type === 'CREDIT_SPREAD') {
      const spreadWidth = Math.abs(
        (parseFloat(position.strike_short) || 0) - (parseFloat(position.strike_long) || 0)
      );
      const creditReceived = parseFloat(position.avg_price);
      const maxLossPerContract = (spreadWidth - creditReceived) * multiplier;
      const totalRisk = maxLossPerContract * position.quantity;
      if (totalRisk > 0) {
        return Math.round((pnl / totalRisk) * 10000) / 10000;
      }
      return null;
    }

    // Debit trades: risk = |entryPrice - stopLoss| * multiplier * qty
    const orderResult = await db.query(
      `SELECT intent_payload FROM sim_orders
       WHERE webhook_event_id = $1 AND side = 'BUY'
       ORDER BY created_at ASC LIMIT 1`,
      [position.webhook_event_id]
    );

    if (orderResult.rows.length > 0) {
      const intent = typeof orderResult.rows[0].intent_payload === 'string'
        ? JSON.parse(orderResult.rows[0].intent_payload)
        : orderResult.rows[0].intent_payload;

      if (intent.stopLoss) {
        const riskPerUnit = Math.abs(parseFloat(position.avg_price) - intent.stopLoss);
        const totalRisk = riskPerUnit * position.quantity * multiplier;
        if (totalRisk > 0) {
          return Math.round((pnl / totalRisk) * 10000) / 10000;
        }
      }
    }

    return null;
  }
}

module.exports = new TradeFinalizerService();
