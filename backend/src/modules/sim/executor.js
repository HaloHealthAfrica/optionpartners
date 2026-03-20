'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const NotificationService = require('../../services/notificationService');
const { assertSimMode } = require('../../config/tradingMode');
const Sentry = require('@sentry/node');
const entryExitValidation = require('./entry-exit-validation.service');

/**
 * Simulated execution engine. Replaces broker execution entirely.
 * All fills are synthetic, deterministic, and reproducible.
 */

const DEFAULT_SLIPPAGE_PCT = parseFloat(process.env.SIM_SLIPPAGE_PCT || '0.001'); // 0.1%
const DEFAULT_SIZE_FACTOR = parseFloat(process.env.SIM_SLIPPAGE_SIZE_FACTOR || '0.01'); // 1% per sqrt(qty)
const DEFAULT_SIZE_MAX = parseFloat(process.env.SIM_SLIPPAGE_SIZE_MAX || '0.10'); // cap 10%
const DEFAULT_COMMISSION = parseFloat(process.env.SIM_COMMISSION || '0.65');      // per contract
const CONTRACT_MULTIPLIER = 100;

class SimExecutor {
  constructor(opts = {}) {
    this.slippagePct = opts.slippagePct ?? DEFAULT_SLIPPAGE_PCT;
    this.sizeFactor = opts.sizeFactor ?? DEFAULT_SIZE_FACTOR;
    this.sizeMax = opts.sizeMax ?? DEFAULT_SIZE_MAX;
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

    // Validate entry parameters before execution
    const entryValidation = await entryExitValidation.validateEntry(intent);
    if (!entryValidation.valid) {
      logger.warn(
        `[ENTRY_VALIDATION] Entry validation warnings: ${entryValidation.warnings.join('; ')}`,
        'sim-executor'
      );
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Advisory lock on (userId, symbol) prevents concurrent entry/exit races.
      // pg_advisory_xact_lock is released automatically at COMMIT/ROLLBACK.
      const lockKey = this._advisoryLockKey(userId, intent.symbol);
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      // 1. Validate account state (FOR UPDATE ensures fresh read within this tx)
      const account = await this._getAccountState(client, userId);
      if (account.kill_switch_active) {
        throw new Error('Kill switch is active -- all orders rejected');
      }

      // 2. Determine fill price (may fall back to price_cache)
      const fillPrice = await this._determineFillPrice(intent);
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

      // 3b. Prevent duplicate positions for the same contract identity.
      // Position identity = underlying_symbol + contract_type + strike + expiration.
      // Allows: different strikes, different expirations, opposite direction (CALL vs PUT).
      if (intent.side === 'BUY' && !intent.positionId) {
        const dupConditions = ['user_id = $1', 'underlying_symbol = $2', "status = 'OPEN'"];
        const dupParams = [userId, intent.symbol];
        let dupIdx = 3;

        if (intent.contractType && intent.contractType !== 'STOCK') {
          dupConditions.push(`contract_type = $${dupIdx++}`);
          dupParams.push(intent.contractType);
        }
        if (intent.strike != null) {
          dupConditions.push(`strike = $${dupIdx++}`);
          dupParams.push(intent.strike);
        }
        if (intent.expiration != null) {
          dupConditions.push(`expiration = $${dupIdx++}`);
          dupParams.push(intent.expiration);
        }

        const existing = await client.query(
          `SELECT id FROM sim_positions WHERE ${dupConditions.join(' AND ')} LIMIT 1`,
          dupParams
        );
        if (existing.rows.length > 0) {
          const key = [intent.symbol, intent.contractType, intent.strike, intent.expiration].filter(Boolean).join('/');
          const order = await this._createOrder(client, intent, userId, 'REJECTED',
            `Duplicate position — already open for ${key}`);
          await client.query('COMMIT');
          return { order, fill: null, position: null };
        }
      }

      // 4. Create sim order
      const isAlternativeStrike = intent.meta?.alternativeStrike === true;
      if (isAlternativeStrike) {
        logger.info(
          `[ALTERNATIVE_ENTRY] ${intent.symbol} ${intent.contractType} $${intent.strike} — entered on alternative strike (excluded: [${(intent.meta?.excludedStrikes || []).join(', ')}])`,
          'sim-executor'
        );
      }
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
      Sentry.captureException(error, { tags: { module: 'sim-executor' } });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Fill price model: mid price with dynamic slippage that accounts for
   * bid-ask spread, order size, and contract type.
   * Falls back to price_cache if the intent carries no price fields.
   * Deterministic given same inputs.
   */
  async _determineFillPrice(intent) {
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
      const cached = await db.query(
        'SELECT price FROM price_cache WHERE symbol = $1',
        [intent.symbol]
      );
      if (cached.rows.length > 0) {
        basePrice = parseFloat(cached.rows[0].price);
        logger.info(`Using cached price for ${intent.symbol}: $${basePrice}`, 'sim-executor');
      } else {
        throw new Error(`No price data available for ${intent.symbol} — send a price tick or include bid/ask/mid in the signal`);
      }
    }

    const slippage = this._calculateSlippage(basePrice, intent);
    const isCreditSpread = intent.contractType === 'CREDIT_SPREAD';

    if (intent.side === 'BUY') {
      return isCreditSpread
        ? Math.round((basePrice - slippage) * 10000) / 10000
        : Math.round((basePrice + slippage) * 10000) / 10000;
    } else {
      return isCreditSpread
        ? Math.round((basePrice + slippage) * 10000) / 10000
        : Math.round((basePrice - slippage) * 10000) / 10000;
    }
  }

  /**
   * Dynamic slippage model incorporating:
   * 1. Base spread-based slippage (half the bid-ask spread, or fallback %)
   * 2. Size impact: larger orders move the price more
   * 3. Contract type: options have wider slippage than stock
   */
  _calculateSlippage(basePrice, intent) {
    // Component 1: Spread-based (most realistic for options); fallback to a percent of price
    let spreadSlippage;
    if (intent.bidPrice && intent.askPrice && intent.askPrice > intent.bidPrice) {
      spreadSlippage = (intent.askPrice - intent.bidPrice) / 2;
    } else {
      spreadSlippage = basePrice * this.slippagePct;
    }

    // Component 2: Size impact — use a sqrt curve capped at a configurable maximum.
    // We subtract 1 so a single contract has zero extra slippage; larger sizes
    // grow sublinearly and are capped by `sizeMax`.
    const qty = Math.max(1, intent.quantity || 1);
    // sizePct = min(sizeFactor * (sqrt(qty) - 1), sizeMax)
    const sizePct = Math.min(this.sizeFactor * Math.max(0, Math.sqrt(qty) - 1), this.sizeMax);
    const sizeMultiplier = 1 + sizePct;

    // Component 3: Contract type factor (options tend to suffer more slippage than stock)
    const typeFactor = intent.contractType === 'STOCK' ? 0.5
      : intent.contractType === 'CREDIT_SPREAD' ? 1.3
      : 1.0;

    return spreadSlippage * sizeMultiplier * typeFactor;
  }

  _calculateRequiredCapital(intent, fillPrice, multiplier) {
    if (intent.contractType === 'CREDIT_SPREAD') {
      // Margin requirement = max loss per contract * qty
      // Max loss = (spread width - credit received) * multiplier
      const spreadWidth = Math.abs((intent.strikeShort || 0) - (intent.strikeLong || 0));
      return (spreadWidth - fillPrice) * multiplier * intent.quantity;
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
      `INSERT INTO sim_orders (id, user_id, webhook_event_id, intent_payload, side, symbol, contract_type, quantity, limit_price, status, rejection_reason, strategy, indicator_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [id, userId, intent.webhookEventId, JSON.stringify(intent), intent.side, intent.symbol,
       intent.contractType, intent.quantity, intent.limitPrice, status, rejectionReason,
       intent.strategy || null, intent.indicatorSource || null]
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

      const contractSymbol = this._formatContractSymbol(intent);
      const underlyingSymbol = intent.symbol;

      const result = await client.query(
        `INSERT INTO sim_positions (id, user_id, symbol, underlying_symbol, contract_type, strike, strike_short, strike_long, expiration, quantity, avg_price, delta_at_entry, strategy, webhook_event_id, status, stop_loss, take_profit, stop_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'OPEN', $15, $16, $17)
         RETURNING *`,
        [id, userId, contractSymbol, underlyingSymbol, intent.contractType,
         intent.strike, intent.strikeShort, intent.strikeLong, intent.expiration,
         intent.quantity, fillPrice, intent.delta, intent.strategy, intent.webhookEventId,
         intent.stopLoss || null, intent.takeProfit || null, intent.stopSource || null]
      );
      return result.rows[0];
    }

    if (intent.positionId || intent.side === 'SELL') {
      // Close (or partially close) an existing position
      const positionId = intent.positionId;
      if (!positionId) {
        const existing = await client.query(
          `SELECT id FROM sim_positions WHERE user_id = $1 AND underlying_symbol = $2 AND status = 'OPEN' ORDER BY opened_at ASC LIMIT 1 FOR UPDATE`,
          [userId, intent.symbol]
        );
        if (existing.rows.length === 0) {
          throw new Error(`No open position to close for ${intent.symbol}`);
        }
        intent.positionId = existing.rows[0].id;
      }

      // Read the current position inside the transaction
      const posRead = await client.query(
        `SELECT * FROM sim_positions WHERE id = $1 AND status = 'OPEN' FOR UPDATE`,
        [intent.positionId]
      );
      if (posRead.rows.length === 0) {
        throw new Error(`Position ${intent.positionId} is no longer OPEN (already closed)`);
      }
      const currentPos = posRead.rows[0];
      const sellQty = intent.quantity || currentPos.quantity;

      if (sellQty < currentPos.quantity) {
        // Partial exit: reduce position quantity, keep OPEN
        const remainingQty = currentPos.quantity - sellQty;
        await client.query(
          `UPDATE sim_positions SET quantity = $2, current_price = $3 WHERE id = $1`,
          [intent.positionId, remainingQty, fillPrice]
        );

        // Create a synthetic closed position record for the partial exit
        const partialId = require('uuid').v4();
        const result = await client.query(
          `INSERT INTO sim_positions (
            id, user_id, symbol, underlying_symbol, contract_type, strike, strike_short, strike_long,
            expiration, quantity, avg_price, delta_at_entry, strategy, webhook_event_id,
            status, stop_loss, take_profit, stop_source, opened_at, closed_at, current_price,
            highest_price, lowest_price, exit_reason
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            'CLOSED', $15, $16, $17, $18, NOW(), $19, $20, $21, $22
          ) RETURNING *`,
          [partialId, userId, currentPos.symbol, currentPos.underlying_symbol,
           currentPos.contract_type, currentPos.strike, currentPos.strike_short,
           currentPos.strike_long, currentPos.expiration, sellQty, currentPos.avg_price,
           currentPos.delta_at_entry, currentPos.strategy, currentPos.webhook_event_id,
           currentPos.stop_loss, currentPos.take_profit, currentPos.stop_source,
           currentPos.opened_at, fillPrice, currentPos.highest_price, currentPos.lowest_price,
           intent.exitReason || null]
        );
        return result.rows[0];
      }

      // Full close
      const result = await client.query(
        `UPDATE sim_positions
         SET status = 'CLOSED', closed_at = NOW(), current_price = $2
         WHERE id = $1 AND status = 'OPEN'
         RETURNING *`,
        [intent.positionId, fillPrice]
      );
      if (result.rows.length === 0) {
        throw new Error(`Position ${intent.positionId} is no longer OPEN (already closed)`);
      }
      return result.rows[0];
    }

    return null;
  }

  /**
   * Format a full option contract symbol from intent fields.
   * If the symbol already contains expiration info (e.g. "TSLA 20260315 P 350"), keep it.
   * Otherwise build it from underlying + expiration + type + strike.
   */
  _formatContractSymbol(intent) {
    if (!intent.contractType || intent.contractType === 'STOCK') {
      return intent.symbol;
    }

    const raw = intent.symbol || '';
    if (/\d{8}/.test(raw)) {
      return raw;
    }

    if (!intent.expiration || !intent.strike) {
      return raw;
    }

    const underlying = raw.toUpperCase();
    const expDate = intent.expiration.replace(/-/g, '').slice(0, 8);
    const typeChar = intent.contractType === 'PUT' ? 'P'
      : intent.contractType === 'CREDIT_SPREAD' ? 'CS'
      : 'C';
    const strike = Number(intent.strike) % 1 === 0
      ? Number(intent.strike).toFixed(0)
      : Number(intent.strike).toString();

    return `${underlying} ${expDate} ${typeChar} ${strike}`;
  }

  /**
   * Derive a stable 32-bit integer for pg_advisory_xact_lock from userId + symbol.
   * Collisions are harmless (extra serialization, not correctness issues).
   */
  _advisoryLockKey(userId, symbol) {
    const str = `${userId}:${symbol}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }

  async _updateLedger(client, userId, intent, fillPrice, multiplier, commission, position) {
    // Load and lock account state to prevent concurrent modifications
    const acctRes = await client.query(
      `SELECT cash_balance, buying_power, margin_used, unrealized_pnl
       FROM sim_account_state
       WHERE user_id = $1
       FOR UPDATE`,
      [userId]
    );
    const acct = acctRes.rows[0];
    if (!acct) throw new Error('Account state missing');

    const notional = fillPrice * intent.quantity * multiplier;
    const isCreditSpread = intent.contractType === 'CREDIT_SPREAD';

    // helper for insufficient funds
    function ensureSufficient(balance, needed, label) {
      if (balance < needed) {
        throw new Error(`Ledger update would drive ${label} negative (${balance} < ${needed})`);
      }
    }

    if (intent.side === 'BUY') {
      if (isCreditSpread) {
        // Credit spread ENTRY: receive premium, hold margin for max loss
        const spreadWidth = Math.abs((intent.strikeShort || 0) - (intent.strikeLong || 0));
        const marginRequired = (spreadWidth - fillPrice) * multiplier * intent.quantity;

        // cash increases by notional minus commission, no negative risk
        ensureSufficient(acct.buying_power, marginRequired, 'buying_power');

        await client.query(
          `UPDATE sim_account_state
           SET cash_balance = cash_balance + $2 - $3,
               buying_power = buying_power - $4,
               margin_used = margin_used + $4,
               updated_at = NOW()
           WHERE user_id = $1`,
          [userId, notional, commission, marginRequired]
        );
      } else {
        // Debit trade ENTRY: pay premium
        const debit = notional + commission;
        ensureSufficient(acct.cash_balance, debit, 'cash_balance');
        ensureSufficient(acct.buying_power, notional, 'buying_power');

        await client.query(
          `UPDATE sim_account_state
           SET cash_balance = cash_balance - $2 - $3,
               buying_power = buying_power - $2,
               margin_used = margin_used + $2,
               updated_at = NOW()
           WHERE user_id = $1`,
          [userId, notional, commission]
        );
      }
    } else if (intent.side === 'SELL' && position) {
      const entryPrice = parseFloat(position.avg_price);
      const exitPrice = fillPrice;
      const qty = position.quantity;

      if (position.contract_type === 'CREDIT_SPREAD') {
        // Credit spread EXIT: pay to buy back the spread, release margin
        const pnl = (entryPrice - exitPrice) * qty * multiplier;
        const spreadWidth = Math.abs(
          (parseFloat(position.strike_short) || 0) - (parseFloat(position.strike_long) || 0)
        );
        const marginHeld = (spreadWidth - entryPrice) * multiplier * qty;
        const debit = exitPrice * qty * multiplier + commission;
        ensureSufficient(acct.cash_balance, debit, 'cash_balance');

        await client.query(
          `UPDATE sim_account_state
           SET cash_balance = cash_balance - $2 - $3,
               buying_power = buying_power + $4,
               margin_used = GREATEST(0, margin_used - $4),
               realized_pnl = realized_pnl + $5,
               daily_pnl = CASE
                 WHEN daily_pnl_reset_at < (NOW() AT TIME ZONE 'America/New_York')::date THEN $5
                 ELSE daily_pnl + $5
               END,
               daily_pnl_reset_at = (NOW() AT TIME ZONE 'America/New_York')::date,
               equity = cash_balance - $2 - $3 + unrealized_pnl,
               updated_at = NOW()
           WHERE user_id = $1`,
          [userId, exitPrice * qty * multiplier, commission, marginHeld, pnl]
        );
      } else {
        // Debit trade EXIT: receive proceeds from selling the option
        const pnl = (exitPrice - entryPrice) * qty * multiplier;
        const entryNotional = entryPrice * qty * multiplier;
        // no negative checks here since cash increases

        await client.query(
          `UPDATE sim_account_state
           SET cash_balance = cash_balance + $2 - $3,
               buying_power = buying_power + $4,
               margin_used = GREATEST(0, margin_used - $4),
               realized_pnl = realized_pnl + $5,
               daily_pnl = CASE
                 WHEN daily_pnl_reset_at < (NOW() AT TIME ZONE 'America/New_York')::date THEN $5
                 ELSE daily_pnl + $5
               END,
               daily_pnl_reset_at = (NOW() AT TIME ZONE 'America/New_York')::date,
               equity = cash_balance + $2 - $3 + unrealized_pnl,
               updated_at = NOW()
           WHERE user_id = $1`,
          [userId, exitPrice * qty * multiplier, commission, entryNotional, pnl]
        );
      }

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
        NotificationService.sendSimKillSwitchNotification(userId, { dailyLoss, maxDailyLoss }).catch(() => {});
      }
    }
  }
}

module.exports = new SimExecutor();
module.exports.SimExecutor = SimExecutor;
