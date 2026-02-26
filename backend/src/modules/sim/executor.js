'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const { assertSimMode } = require('../../config/tradingMode');

/**
 * Simulated execution engine. Replaces broker execution entirely.
 * All fills are synthetic, deterministic, and reproducible.
 */

const DEFAULT_SLIPPAGE_PCT = parseFloat(process.env.SIM_SLIPPAGE_PCT || '0.001'); // 0.1%
const DEFAULT_COMMISSION = parseFloat(process.env.SIM_COMMISSION || '0.65');      // per contract
const CONTRACT_MULTIPLIER = 100;

class SimExecutor {
  constructor(opts = {}) {
    this.slippagePct = opts.slippagePct ?? DEFAULT_SLIPPAGE_PCT;
    this.commission = opts.commission ?? DEFAULT_COMMISSION;
  }

  /**
   * Execute a simulated order from an approved order intent.
   * Follows: validateAccountState -> determineFillPrice -> createSimOrder -> createSimFill -> updatePosition -> updateLedger
   *
   * @param {import('./decision-router').SimOrderIntent} intent
   * @param {string} userId
   * @returns {Promise<{order: Object, fill: Object, position: Object}>}
   */
  async simulateOrder(intent, userId) {
    assertSimMode();

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // 1. Validate account state
      const account = await this._getAccountState(client, userId);
      if (account.kill_switch_active) {
        throw new Error('Kill switch is active -- all orders rejected');
      }

      // 2. Determine fill price
      const fillPrice = this._determineFillPrice(intent);
      const multiplier = intent.contractType === 'STOCK' ? 1 : CONTRACT_MULTIPLIER;
      const notionalValue = fillPrice * intent.quantity * multiplier;
      const totalCommission = this.commission * intent.quantity * (intent.contractType === 'STOCK' ? 0 : 1);

      // 3. Validate buying power for buys
      if (intent.side === 'BUY') {
        const requiredCapital = this._calculateRequiredCapital(intent, fillPrice, multiplier);
        if (requiredCapital > account.buying_power) {
          const order = await this._createOrder(client, intent, userId, 'REJECTED', 'Insufficient buying power');
          await client.query('COMMIT');
          return { order, fill: null, position: null };
        }
      }

      // 4. Create sim order
      const order = await this._createOrder(client, intent, userId, 'FILLED');

      // 5. Create sim fill
      const fill = await this._createFill(client, order.id, userId, fillPrice, intent.quantity, multiplier, totalCommission);

      // 6. Update or create position
      const position = await this._updatePosition(client, intent, userId, fillPrice, order.id);

      // 7. Update ledger
      await this._updateLedger(client, userId, intent, fillPrice, multiplier, totalCommission, position);

      await client.query('COMMIT');

      logger.info(
        `SIM ORDER FILLED: ${intent.side} ${intent.quantity}x ${intent.symbol} ${intent.contractType} @ ${fillPrice}`,
        'sim-executor'
      );

      return { order, fill, position };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Sim execution failed: ${error.message}`, 'sim-executor');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Fill price model: default mid price with configurable slippage.
   * Deterministic given same inputs.
   */
  _determineFillPrice(intent) {
    let basePrice;

    if (intent.midPrice) {
      basePrice = intent.midPrice;
    } else if (intent.bidPrice && intent.askPrice) {
      basePrice = (intent.bidPrice + intent.askPrice) / 2;
    } else if (intent.limitPrice) {
      basePrice = intent.limitPrice;
    } else if (intent.askPrice) {
      basePrice = intent.askPrice;
    } else if (intent.bidPrice) {
      basePrice = intent.bidPrice;
    } else {
      throw new Error('No price data available for fill calculation');
    }

    // Apply slippage: adverse direction
    const slippage = basePrice * this.slippagePct;
    if (intent.side === 'BUY') {
      return Math.round((basePrice + slippage) * 10000) / 10000;
    } else {
      return Math.round((basePrice - slippage) * 10000) / 10000;
    }
  }

  _calculateRequiredCapital(intent, fillPrice, multiplier) {
    if (intent.contractType === 'CREDIT_SPREAD') {
      // For credit spreads, max loss = spread width - credit received
      const spreadWidth = Math.abs((intent.strikeShort || 0) - (intent.strikeLong || 0));
      return (spreadWidth * multiplier - fillPrice * multiplier) * intent.quantity;
    }
    return fillPrice * intent.quantity * multiplier;
  }

  async _getAccountState(client, userId) {
    const result = await client.query(
      'SELECT * FROM sim_account_state WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (result.rows.length === 0) {
      throw new Error('No sim account state found. Initialize account first.');
    }
    return result.rows[0];
  }

  async _createOrder(client, intent, userId, status, rejectionReason = null) {
    const id = uuidv4();
    const result = await client.query(
      `INSERT INTO sim_orders (id, user_id, webhook_event_id, intent_payload, side, symbol, contract_type, quantity, limit_price, status, rejection_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [id, userId, intent.webhookEventId, JSON.stringify(intent), intent.side, intent.symbol,
       intent.contractType, intent.quantity, intent.limitPrice, status, rejectionReason]
    );
    return result.rows[0];
  }

  async _createFill(client, orderId, userId, fillPrice, quantity, multiplier, commission) {
    const id = uuidv4();
    const notionalValue = fillPrice * quantity * multiplier;
    const result = await client.query(
      `INSERT INTO sim_fills (id, order_id, user_id, fill_price, quantity, slippage_applied, commission, contract_multiplier, notional_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [id, orderId, userId, fillPrice, quantity, this.slippagePct, commission, multiplier, notionalValue]
    );
    return result.rows[0];
  }

  async _updatePosition(client, intent, userId, fillPrice, orderId) {
    if (intent.side === 'BUY' && !intent.positionId) {
      // Open new position
      const id = uuidv4();
      const dte = intent.expiration
        ? Math.ceil((new Date(intent.expiration) - Date.now()) / (1000 * 60 * 60 * 24))
        : null;

      const result = await client.query(
        `INSERT INTO sim_positions (id, user_id, symbol, underlying_symbol, contract_type, strike, strike_short, strike_long, expiration, quantity, avg_price, delta_at_entry, strategy, webhook_event_id, status, stop_loss, take_profit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'OPEN', $15, $16)
         RETURNING *`,
        [id, userId, intent.symbol, intent.symbol, intent.contractType,
         intent.strike, intent.strikeShort, intent.strikeLong, intent.expiration,
         intent.quantity, fillPrice, intent.delta, intent.strategy, intent.webhookEventId,
         intent.stopLoss || null, intent.takeProfit || null]
      );
      return result.rows[0];
    }

    if (intent.positionId || intent.side === 'SELL') {
      // Close existing position
      const positionId = intent.positionId;
      if (!positionId) {
        const existing = await client.query(
          `SELECT id FROM sim_positions WHERE user_id = $1 AND symbol = $2 AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1`,
          [userId, intent.symbol]
        );
        if (existing.rows.length === 0) {
          throw new Error(`No open position to close for ${intent.symbol}`);
        }
        intent.positionId = existing.rows[0].id;
      }

      const result = await client.query(
        `UPDATE sim_positions
         SET status = 'CLOSED', closed_at = NOW(), current_price = $2
         WHERE id = $1
         RETURNING *`,
        [intent.positionId, fillPrice]
      );
      return result.rows[0];
    }

    return null;
  }

  async _updateLedger(client, userId, intent, fillPrice, multiplier, commission, position) {
    const notional = fillPrice * intent.quantity * multiplier;

    if (intent.side === 'BUY') {
      // Debit: reduce cash, increase margin used
      let marginRequired;
      if (intent.contractType === 'CREDIT_SPREAD') {
        const spreadWidth = Math.abs((intent.strikeShort || 0) - (intent.strikeLong || 0));
        marginRequired = (spreadWidth * multiplier - notional) * intent.quantity / intent.quantity;
      } else {
        marginRequired = notional;
      }

      await client.query(
        `UPDATE sim_account_state
         SET cash_balance = cash_balance - $2 - $3,
             buying_power = buying_power - $4,
             margin_used = margin_used + $4,
             updated_at = NOW()
         WHERE user_id = $1`,
        [userId, notional, commission, marginRequired]
      );
    } else if (intent.side === 'SELL' && position) {
      // Credit: calculate PnL and update balances
      const entryPrice = parseFloat(position.avg_price);
      const exitPrice = fillPrice;
      const qty = position.quantity;
      const pnl = (exitPrice - entryPrice) * qty * multiplier;

      // For short positions (credit spreads), PnL is inverted
      const adjustedPnl = position.contract_type === 'CREDIT_SPREAD'
        ? (entryPrice - exitPrice) * qty * multiplier
        : pnl;

      const entryNotional = entryPrice * qty * multiplier;

      await client.query(
        `UPDATE sim_account_state
         SET cash_balance = cash_balance + $2 - $3,
             buying_power = buying_power + $4,
             margin_used = GREATEST(0, margin_used - $4),
             realized_pnl = realized_pnl + $5,
             daily_pnl = CASE
               WHEN daily_pnl_reset_at < CURRENT_DATE THEN $5
               ELSE daily_pnl + $5
             END,
             daily_pnl_reset_at = CURRENT_DATE,
             equity = cash_balance + $2 - $3 + unrealized_pnl,
             updated_at = NOW()
         WHERE user_id = $1`,
        [userId, exitPrice * qty * multiplier, commission, entryNotional, adjustedPnl]
      );

      // Update peak equity and max drawdown
      await client.query(
        `UPDATE sim_account_state
         SET peak_equity = GREATEST(peak_equity, equity),
             max_drawdown = GREATEST(max_drawdown, peak_equity - equity)
         WHERE user_id = $1`,
        [userId]
      );

      // Auto-activate kill switch if daily loss exceeds limit
      const updatedAccount = await client.query(
        'SELECT daily_pnl FROM sim_account_state WHERE user_id = $1',
        [userId]
      );
      const dailyLoss = Math.abs(Math.min(0, parseFloat(updatedAccount.rows[0]?.daily_pnl || 0)));
      const maxDailyLoss = parseFloat(process.env.SIM_MAX_DAILY_LOSS || '2000');
      if (dailyLoss >= maxDailyLoss) {
        await client.query(
          `UPDATE sim_account_state SET kill_switch_active = TRUE WHERE user_id = $1`,
          [userId]
        );
        logger.warn(`Auto kill switch: daily loss $${dailyLoss} >= $${maxDailyLoss} for user ${userId}`, 'sim-executor');
      }
    }
  }
}

module.exports = new SimExecutor();
module.exports.SimExecutor = SimExecutor;
