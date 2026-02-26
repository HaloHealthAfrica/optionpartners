'use strict';

const db = require('../../config/database');
const executor = require('./executor');
const tradeFinalizer = require('./trade-finalizer');
const ledgerService = require('./ledger.service');
const logger = require('../../utils/logger');

/**
 * Background exit monitor -- checks open positions for stop-loss,
 * take-profit, DTE expiry, trailing stops, and max hold duration.
 * Generates internal CLOSE orders when thresholds are breached.
 */
class ExitMonitor {
  constructor() {
    this._running = false;
    this._intervalId = null;
    this._checksRun = 0;
    this._exitsTriggered = 0;
  }

  start(intervalMs = 15000) {
    if (this._running) return;
    this._running = true;

    logger.info(`Exit monitor started (checking every ${intervalMs}ms)`, 'exit-monitor');

    this._intervalId = setInterval(async () => {
      try {
        await this.checkAllPositions();
      } catch (error) {
        logger.error(`Exit monitor poll error: ${error.message}`, 'exit-monitor');
      }
    }, intervalMs);
  }

  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._running = false;
    logger.info('Exit monitor stopped', 'exit-monitor');
  }

  getStatus() {
    return {
      running: this._running,
      checksRun: this._checksRun,
      exitsTriggered: this._exitsTriggered,
    };
  }

  async checkAllPositions() {
    const positions = await db.query(
      `SELECT p.*, s.enable_exit_monitor, s.default_trailing_stop_pct,
              s.default_max_hold_hours, s.force_close_at_dte_zero
       FROM sim_positions p
       LEFT JOIN sim_intelligence_config s ON s.user_id = p.user_id
       WHERE p.status = 'OPEN'`
    );

    this._checksRun++;

    for (const pos of positions.rows) {
      if (pos.enable_exit_monitor === false) continue;

      try {
        await this._evaluatePosition(pos);
      } catch (error) {
        logger.error(`Exit check failed for position ${pos.id}: ${error.message}`, 'exit-monitor');
      }
    }
  }

  async _evaluatePosition(position) {
    const currentPrice = await this._getLatestPrice(position);
    if (!currentPrice) return;

    await db.query(
      'UPDATE sim_positions SET current_price = $2 WHERE id = $1',
      [position.id, currentPrice]
    );

    const entryPrice = parseFloat(position.avg_price);
    const isCreditSpread = position.contract_type === 'CREDIT_SPREAD';

    // Track highest price for trailing stops
    const prevHighest = parseFloat(position.highest_price || entryPrice);
    const newHighest = Math.max(prevHighest, currentPrice);
    if (newHighest > prevHighest) {
      await db.query(
        'UPDATE sim_positions SET highest_price = $2 WHERE id = $1',
        [position.id, newHighest]
      );
    }

    // 1. Stop-loss check
    if (position.stop_loss) {
      const stopLoss = parseFloat(position.stop_loss);
      const breached = isCreditSpread
        ? currentPrice >= stopLoss
        : currentPrice <= stopLoss;

      if (breached) {
        await this._triggerExit(position, currentPrice, 'STOP_LOSS', `Price ${currentPrice} breached stop-loss ${stopLoss}`);
        return;
      }
    }

    // 2. Take-profit check
    if (position.take_profit) {
      const takeProfit = parseFloat(position.take_profit);
      const reached = isCreditSpread
        ? currentPrice <= takeProfit
        : currentPrice >= takeProfit;

      if (reached) {
        await this._triggerExit(position, currentPrice, 'TAKE_PROFIT', `Price ${currentPrice} reached take-profit ${takeProfit}`);
        return;
      }
    }

    // 3. DTE expiry check
    if (position.expiration && (position.force_close_at_dte_zero !== false)) {
      const dte = Math.ceil((new Date(position.expiration) - Date.now()) / (1000 * 60 * 60 * 24));
      if (dte <= 0) {
        await this._triggerExit(position, currentPrice, 'DTE_EXPIRY', `Position expired (DTE=${dte})`);
        return;
      }
    }

    // 4. Trailing stop check
    const trailingPct = parseFloat(position.trailing_stop_pct || position.default_trailing_stop_pct || 0);
    if (trailingPct > 0 && !isCreditSpread) {
      const trailingStop = newHighest * (1 - trailingPct);
      if (currentPrice <= trailingStop && currentPrice < newHighest) {
        await this._triggerExit(
          position, currentPrice, 'TRAILING_STOP',
          `Price ${currentPrice} fell below trailing stop ${trailingStop.toFixed(4)} (${(trailingPct * 100).toFixed(1)}% from high ${newHighest})`
        );
        return;
      }
    }

    // 5. Max hold duration check
    const maxHoldHours = position.max_hold_hours || position.default_max_hold_hours;
    if (maxHoldHours) {
      const hoursOpen = (Date.now() - new Date(position.opened_at).getTime()) / (1000 * 60 * 60);
      if (hoursOpen >= maxHoldHours) {
        await this._triggerExit(
          position, currentPrice, 'MAX_HOLD_DURATION',
          `Position open ${hoursOpen.toFixed(1)}h exceeds max ${maxHoldHours}h`
        );
        return;
      }
    }
  }

  /**
   * Get the latest price for a position. Checks:
   * 1. Most recent webhook payload for the same symbol
   * 2. Falls back to the position's current_price or avg_price
   */
  async _getLatestPrice(position) {
    const result = await db.query(
      `SELECT raw_payload FROM webhook_events
       WHERE user_id = $1
         AND status IN ('PROCESSED', 'RECEIVED')
         AND raw_payload->>'symbol' = $2
       ORDER BY received_at DESC LIMIT 1`,
      [position.user_id, position.symbol]
    );

    if (result.rows.length > 0) {
      const payload = typeof result.rows[0].raw_payload === 'string'
        ? JSON.parse(result.rows[0].raw_payload)
        : result.rows[0].raw_payload;

      const price = payload.close || payload.price || payload.mid_price
        || payload.midPrice || payload.last;
      if (price) return parseFloat(price);
    }

    return position.current_price ? parseFloat(position.current_price) : null;
  }

  async _triggerExit(position, exitPrice, reason, message) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const intent = {
        symbol: position.symbol,
        side: 'SELL',
        contractType: position.contract_type,
        strike: position.strike,
        strikeShort: position.strike_short,
        strikeLong: position.strike_long,
        expiration: position.expiration,
        quantity: position.quantity,
        strategy: position.strategy,
        midPrice: exitPrice,
        indicatorSource: 'EXIT_MONITOR',
        webhookEventId: position.webhook_event_id,
        positionId: position.id,
      };

      await client.query('COMMIT');

      const { order, fill, position: closedPos } = await executor.simulateOrder(intent, position.user_id);

      if (closedPos && closedPos.status === 'CLOSED') {
        await db.query(
          'UPDATE sim_positions SET exit_reason = $2 WHERE id = $1',
          [position.id, reason]
        );
        await tradeFinalizer.finalize(closedPos, parseFloat(fill.fill_price), position.user_id);
      }

      this._exitsTriggered++;
      logger.info(`EXIT TRIGGERED [${reason}]: ${position.symbol} @ ${exitPrice} — ${message}`, 'exit-monitor');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Exit trigger failed for ${position.id}: ${error.message}`, 'exit-monitor');
    } finally {
      client.release();
    }
  }
}

module.exports = new ExitMonitor();
