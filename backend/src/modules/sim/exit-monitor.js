'use strict';

const db = require('../../config/database');
const executor = require('./executor');
const tradeFinalizer = require('./trade-finalizer');
const ledgerService = require('./ledger.service');
const NotificationService = require('../../services/notificationService');
const dataServiceProxy = require('../../services/dataServiceProxy');
const marketContext = require('./market-context.service');
const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');

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
    this._regimeCache = new Map();
    this._gexCache = new Map();
    this._REGIME_CACHE_TTL_MS = 5 * 60 * 1000;
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
        Sentry.captureException(error, { tags: { module: 'exit-monitor' } });
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
    // Evict expired entries from regime cache at cycle start
    const now = Date.now();
    for (const [sym, entry] of this._regimeCache) {
      if (now - entry.fetchedAt > this._REGIME_CACHE_TTL_MS) {
        this._regimeCache.delete(sym);
      }
    }

    const positions = await db.query(
      `SELECT p.*, s.enable_exit_monitor, s.default_trailing_stop_pct,
              s.default_max_hold_hours, s.force_close_at_dte_zero
       FROM sim_positions p
       LEFT JOIN sim_intelligence_config s ON s.user_id = p.user_id
       WHERE p.status = 'OPEN'`
    );

    this._checksRun++;

    const userIds = new Set();
    for (const pos of positions.rows) {
      if (pos.enable_exit_monitor === false) continue;

      try {
        await this._evaluatePosition(pos);
        userIds.add(pos.user_id);
      } catch (error) {
        logger.error(`Exit check failed for position ${pos.id}: ${error.message}`, 'exit-monitor');
        Sentry.captureException(error, { tags: { module: 'exit-monitor' } });
      }
    }

    for (const uid of userIds) {
      await this._refreshUnrealizedPnl(uid);
    }

    // Run reconciliation periodically (every ~20 cycles = ~5 min at 15s interval)
    if (this._checksRun % 20 === 0) {
      await this._reconcilePositions();
    }
  }

  async _evaluatePosition(position) {
    const underlyingPrice = await this._getLatestPrice(position);
    if (!underlyingPrice) return;

    const isOption = position.contract_type !== 'STOCK';
    const optionPrice = isOption
      ? await this._estimateOptionPrice(position, underlyingPrice)
      : underlyingPrice;

    // Store option price (not underlying) so unrealized PnL is correct
    await db.query(
      'UPDATE sim_positions SET current_price = $2 WHERE id = $1',
      [position.id, optionPrice]
    );

    const isCreditSpread = position.contract_type === 'CREDIT_SPREAD';
    const isPut = position.contract_type === 'PUT';
    const profitsWhenDown = isPut;

    // Watermarks track the underlying for stop/TP comparison
    const prevHighest = parseFloat(position.highest_price || underlyingPrice);
    const prevLowest = parseFloat(position.lowest_price || underlyingPrice);
    const newHighest = Math.max(prevHighest, underlyingPrice);
    const newLowest = Math.min(prevLowest, underlyingPrice);

    const updates = [];
    const updateParams = [position.id];
    let paramIdx = 2;
    if (newHighest > prevHighest) {
      updates.push(`highest_price = $${paramIdx++}`);
      updateParams.push(newHighest);
    }
    if (newLowest < prevLowest) {
      updates.push(`lowest_price = $${paramIdx++}`);
      updateParams.push(newLowest);
    }
    if (updates.length > 0) {
      await db.query(
        `UPDATE sim_positions SET ${updates.join(', ')} WHERE id = $1`,
        updateParams
      );
    }

    // 0. Gap risk detection — if price jumped significantly from last known level,
    // log a gap event so analytics can track gap-through-stop scenarios.
    const lastKnown = parseFloat(position.current_price || position.avg_price);
    if (lastKnown > 0 && !isOption) {
      const gapPct = Math.abs(underlyingPrice - lastKnown) / lastKnown;
      if (gapPct > 0.05) {
        logger.warn(
          `[GAP_DETECTED] ${position.symbol}: price moved ${(gapPct * 100).toFixed(1)}% from ${lastKnown} to ${underlyingPrice}`,
          'exit-monitor'
        );
      }
    }

    // 1. Stop-loss check (compare underlying price against underlying-based stop levels)
    if (position.stop_loss) {
      const stopLoss = parseFloat(position.stop_loss);
      let breached;
      if (isCreditSpread) {
        breached = underlyingPrice >= stopLoss;
      } else if (profitsWhenDown) {
        breached = underlyingPrice >= stopLoss;
      } else {
        breached = underlyingPrice <= stopLoss;
      }

      if (breached) {
        await this._triggerExit(position, optionPrice, 'STOP_LOSS', `Underlying ${underlyingPrice} breached stop-loss ${stopLoss}`);
        return;
      }
    }

    // 2. Take-profit check (compare underlying price against underlying-based TP levels)
    if (position.take_profit) {
      const takeProfit = parseFloat(position.take_profit);
      let reached;
      if (isCreditSpread) {
        reached = underlyingPrice <= takeProfit;
      } else if (profitsWhenDown) {
        reached = underlyingPrice <= takeProfit;
      } else {
        reached = underlyingPrice >= takeProfit;
      }

      if (reached) {
        await this._triggerExit(position, optionPrice, 'TAKE_PROFIT', `Underlying ${underlyingPrice} reached take-profit ${takeProfit}`);
        return;
      }
    }

    // 3. DTE expiry check
    if (position.expiration && (position.force_close_at_dte_zero !== false)) {
      const dte = Math.ceil((new Date(position.expiration) - Date.now()) / (1000 * 60 * 60 * 24));
      if (dte <= 0) {
        await this._triggerExit(position, optionPrice, 'DTE_EXPIRY', `Position expired (DTE=${dte})`);
        return;
      }
    }

    // 4. Trailing stop check (tracks underlying price movement)
    const sym = position.underlying_symbol || position.symbol;
    const regimeData = await this._getRegimeForSymbol(sym);
    const regime = regimeData?.regime || null;
    const gexData = await this._getGEXForSymbol(sym);

    const baseTrailingPct = parseFloat(position.trailing_stop_pct || position.default_trailing_stop_pct || 0);
    const baseMaxHold = position.max_hold_hours || position.default_max_hold_hours;
    const exitAdj = this._applyRegimeExitAdjustments(baseTrailingPct, baseMaxHold, regime, gexData, underlyingPrice);
    const trailingPct = exitAdj.trailingPct;

    if (trailingPct > 0 && !isCreditSpread) {
      if (profitsWhenDown) {
        const trailingStop = newLowest * (1 + trailingPct);
        if (underlyingPrice >= trailingStop && underlyingPrice > newLowest) {
          await this._triggerExit(
            position, optionPrice, 'TRAILING_STOP',
            `Underlying ${underlyingPrice} rose above trailing stop ${trailingStop.toFixed(4)} (${(trailingPct * 100).toFixed(1)}% from low ${newLowest})`
          );
          return;
        }
      } else {
        const trailingStop = newHighest * (1 - trailingPct);
        if (underlyingPrice <= trailingStop && underlyingPrice < newHighest) {
          await this._triggerExit(
            position, optionPrice, 'TRAILING_STOP',
            `Underlying ${underlyingPrice} fell below trailing stop ${trailingStop.toFixed(4)} (${(trailingPct * 100).toFixed(1)}% from high ${newHighest})`
          );
          return;
        }
      }
    }

    // 5. Max hold duration check (regime-adjusted)
    const maxHoldHours = exitAdj.maxHoldHours;
    if (maxHoldHours) {
      const hoursOpen = (Date.now() - new Date(position.opened_at).getTime()) / (1000 * 60 * 60);
      if (hoursOpen >= maxHoldHours) {
        await this._triggerExit(
          position, optionPrice, 'MAX_HOLD_DURATION',
          `Position open ${hoursOpen.toFixed(1)}h exceeds max ${maxHoldHours}h`
        );
        return;
      }
    }
  }

  /**
   * Fetch regime for a symbol with per-cycle caching to avoid hammering the data service.
   * Returns null on failure — exit monitor continues with base parameters.
   */
  async _getRegimeForSymbol(symbol) {
    const cached = this._regimeCache.get(symbol);
    if (cached && (Date.now() - cached.fetchedAt) < this._REGIME_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const result = await dataServiceProxy.getHistoricalRegime(symbol);
      if (result?.regime) {
        this._regimeCache.set(symbol, { data: result, fetchedAt: Date.now() });
        return result;
      }
    } catch (_) {
      // Regime unavailable — exit monitor proceeds with default params
    }

    return null;
  }

  /**
   * Apply regime + GEX-based adjustments to exit parameters.
   *
   * HIGH_VOL_EXPANSION: wider trailing stop (allow runners), extend max hold
   * LOW_VOL_CHOP:       tighter trailing stop, reduce max hold (time stop)
   * TRENDING:           wider trailing stop, extend max hold
   *
   * GEX negative: wider trailing (explosive moves expected)
   * GEX positive: tighter trailing (price likely to pin)
   */
  _applyRegimeExitAdjustments(trailingPct, maxHoldHours, regime, gexData = null, currentPrice = null) {
    if (!regime && !gexData) return { trailingPct, maxHoldHours, regimeAdjusted: false };

    let adjTrailing = trailingPct;
    let adjMaxHold = maxHoldHours;

    switch (regime) {
      case 'HIGH_VOL_EXPANSION':
        adjTrailing = trailingPct * 1.5;
        adjMaxHold = maxHoldHours ? maxHoldHours * 1.5 : null;
        break;
      case 'LOW_VOL_CHOP':
        adjTrailing = trailingPct * 0.7;
        adjMaxHold = maxHoldHours ? maxHoldHours * 0.75 : null;
        break;
      case 'TRENDING':
        adjTrailing = trailingPct * 1.3;
        adjMaxHold = maxHoldHours ? maxHoldHours * 1.25 : null;
        break;
    }

    // GEX-based trailing stop adjustment
    if (gexData?.net_gex != null && adjTrailing > 0) {
      if (gexData.net_gex < -500_000_000) {
        // Strong negative GEX = explosive moves — widen trailing to let runners run
        adjTrailing *= 1.2;
      } else if (gexData.net_gex > 500_000_000) {
        // Strong positive GEX = price pinning — tighten trailing to lock in gains
        adjTrailing *= 0.85;
      }
    }

    return { trailingPct: adjTrailing, maxHoldHours: adjMaxHold, regimeAdjusted: true };
  }

  /**
   * Fetch GEX data for a symbol with caching to avoid excessive DB hits.
   */
  async _getGEXForSymbol(symbol) {
    const cached = this._gexCache.get(symbol);
    if (cached && (Date.now() - cached.fetchedAt) < this._REGIME_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const data = await marketContext.getLatestGEX(symbol);
      if (data) {
        this._gexCache.set(symbol, { data, fetchedAt: Date.now() });
      }
      return data;
    } catch (_) {
      return null;
    }
  }

  /**
   * Get the latest price for a position. Returns null if no fresh
   * price is available (stale prices outside market hours are rejected
   * to prevent false exit triggers).
   */
  async _getLatestPrice(position) {
    const MAX_PRICE_AGE_MS = parseInt(process.env.SIM_MAX_PRICE_AGE_MS || '900000', 10); // 15 min default

    // Check price_cache first for the most reliable/recent price
    const cached = await db.query(
      'SELECT price, updated_at FROM price_cache WHERE symbol = $1',
      [position.symbol]
    );
    if (cached.rows.length > 0) {
      const ageMs = Date.now() - new Date(cached.rows[0].updated_at).getTime();
      if (ageMs > MAX_PRICE_AGE_MS) {
        // Price is stale — likely outside market hours. Skip evaluation
        // to avoid false exits on after-hours or weekend data.
        return null;
      }
      return parseFloat(cached.rows[0].price);
    }

    // Fall back to most recent webhook payload (check both symbol and ticker fields)
    const result = await db.query(
      `SELECT raw_payload, received_at FROM webhook_events
       WHERE user_id = $1
         AND status IN ('PROCESSED', 'RECEIVED')
         AND (raw_payload->>'symbol' = $2 OR raw_payload->>'ticker' = $2)
       ORDER BY received_at DESC LIMIT 1`,
      [position.user_id, position.symbol]
    );

    if (result.rows.length > 0) {
      const ageMs = Date.now() - new Date(result.rows[0].received_at).getTime();
      if (ageMs > MAX_PRICE_AGE_MS) return null;

      const payload = typeof result.rows[0].raw_payload === 'string'
        ? JSON.parse(result.rows[0].raw_payload)
        : result.rows[0].raw_payload;

      const price = payload.close || payload.price || payload.mid_price
        || payload.midPrice || payload.last;
      if (price) return parseFloat(price);
    }

    return null;
  }

  /**
   * Estimate the current option price for a position.
   * Tries live chain data first, falls back to intrinsic value.
   */
  async _estimateOptionPrice(position, underlyingPrice) {
    // Try live chain data from the data service
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
      // Data service unavailable — fall back to intrinsic estimation
    }

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
        // Model both legs: short leg liability minus long leg value.
        // For a put credit spread (short high strike, long low strike):
        const isCallSpread = shortStrike < longStrike;
        let shortIntrinsic, longIntrinsic;
        if (isCallSpread) {
          shortIntrinsic = Math.max(0, underlyingPrice - shortStrike);
          longIntrinsic = Math.max(0, underlyingPrice - longStrike);
        } else {
          shortIntrinsic = Math.max(0, shortStrike - underlyingPrice);
          longIntrinsic = Math.max(0, longStrike - underlyingPrice);
        }
        // Spread debit to close = short leg cost - long leg credit
        const spreadValue = Math.max(0, shortIntrinsic - longIntrinsic);
        // Add small extrinsic estimate (decays toward expiry)
        const dte = position.expiration
          ? Math.max(0, (new Date(position.expiration) - Date.now()) / (1000 * 60 * 60 * 24))
          : 0;
        const extrinsicEstimate = dte > 0 ? 0.02 * Math.sqrt(dte) : 0;
        return Math.max(0.01, spreadValue + extrinsicEstimate);
      }
    }

    return parseFloat(position.avg_price);
  }

  async _triggerExit(position, exitPrice, reason, message) {
    // Idempotency: verify position is still OPEN before attempting exit
    const check = await db.query(
      'SELECT status FROM sim_positions WHERE id = $1',
      [position.id]
    );
    if (check.rows.length === 0 || check.rows[0].status !== 'OPEN') {
      logger.info(`Exit skipped for ${position.id}: position is no longer OPEN`, 'exit-monitor');
      return;
    }

    try {
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

      const { order, fill, position: closedPos } = await executor.simulateOrder(intent, position.user_id);

      if (closedPos && closedPos.status === 'CLOSED') {
        await db.query(
          'UPDATE sim_positions SET exit_reason = $2 WHERE id = $1',
          [position.id, reason]
        );
        closedPos.exit_reason = reason;
        const trade = await tradeFinalizer.finalize(closedPos, parseFloat(fill.fill_price), position.user_id);
        NotificationService.sendSimTradeClosedNotification(position.user_id, {
          symbol: position.symbol, contractType: position.contract_type,
          pnl: trade?.pnl, pnlPercent: trade?.pnl_percent,
          exitReason: reason, tradeId: trade?.id,
        }).catch(() => {});
      }

      this._exitsTriggered++;
      logger.info(`EXIT TRIGGERED [${reason}]: ${position.symbol} @ ${exitPrice} — ${message}`, 'exit-monitor');
    } catch (error) {
      logger.error(`Exit trigger failed for ${position.id}: ${error.message}`, 'exit-monitor');
      Sentry.captureException(error, { tags: { module: 'exit-monitor' } });
    }
  }

  /**
   * Periodically verify ledger consistency. Detects orphaned positions
   * (OPEN with no matching order) and logs margin/buying power drift.
   */
  async _reconcilePositions() {
    try {
      // Find orphaned OPEN positions with no matching order
      const orphaned = await db.query(
        `SELECT p.id, p.symbol, p.user_id
         FROM sim_positions p
         LEFT JOIN sim_orders o ON o.webhook_event_id = p.webhook_event_id AND o.status = 'FILLED'
         WHERE p.status = 'OPEN' AND o.id IS NULL`
      );
      if (orphaned.rows.length > 0) {
        logger.warn(
          `[RECONCILIATION] Found ${orphaned.rows.length} orphaned OPEN position(s) with no matching filled order`,
          'exit-monitor'
        );
        for (const pos of orphaned.rows) {
          logger.warn(`[RECONCILIATION] Orphaned: position=${pos.id} symbol=${pos.symbol} user=${pos.user_id}`, 'exit-monitor');
        }
      }

      // Check buying power consistency per user
      const users = await db.query(
        `SELECT a.user_id, a.cash_balance, a.buying_power, a.margin_used,
                COALESCE(SUM(
                  CASE WHEN p.contract_type = 'CREDIT_SPREAD'
                    THEN (ABS(COALESCE(p.strike_short::numeric,0) - COALESCE(p.strike_long::numeric,0)) - p.avg_price) * p.quantity * 100
                    ELSE p.avg_price * p.quantity * CASE WHEN p.contract_type = 'STOCK' THEN 1 ELSE 100 END
                  END
                ), 0) as expected_margin
         FROM sim_account_state a
         LEFT JOIN sim_positions p ON p.user_id = a.user_id AND p.status = 'OPEN'
         GROUP BY a.user_id, a.cash_balance, a.buying_power, a.margin_used`
      );

      for (const row of users.rows) {
        const drift = Math.abs(parseFloat(row.margin_used) - parseFloat(row.expected_margin));
        if (drift > 1) {
          logger.warn(
            `[RECONCILIATION] Margin drift for user ${row.user_id}: recorded=$${parseFloat(row.margin_used).toFixed(2)} expected=$${parseFloat(row.expected_margin).toFixed(2)} drift=$${drift.toFixed(2)}`,
            'exit-monitor'
          );
        }
      }
    } catch (err) {
      logger.error(`Reconciliation failed: ${err.message}`, 'exit-monitor');
    }
  }

  async _refreshUnrealizedPnl(userId) {
    try {
      const result = await db.query(
        `SELECT COALESCE(SUM(
          CASE
            WHEN contract_type = 'CREDIT_SPREAD'
              THEN (avg_price - COALESCE(current_price, avg_price)) * quantity * 100
            WHEN contract_type = 'STOCK'
              THEN (COALESCE(current_price, avg_price) - avg_price) * quantity
            ELSE
              (COALESCE(current_price, avg_price) - avg_price) * quantity * 100
          END
        ), 0) as unrealized
        FROM sim_positions
        WHERE user_id = $1 AND status = 'OPEN'`,
        [userId]
      );

      const unrealized = parseFloat(result.rows[0].unrealized) || 0;

      await db.query(
        `UPDATE sim_account_state
         SET unrealized_pnl = $2,
             equity = cash_balance + $2,
             peak_equity = GREATEST(peak_equity, cash_balance + $2),
             max_drawdown = GREATEST(max_drawdown, peak_equity - (cash_balance + $2)),
             updated_at = NOW()
         WHERE user_id = $1`,
        [userId, unrealized]
      );
    } catch (err) {
      logger.error(`Failed to refresh unrealized PnL for user ${userId}: ${err.message}`, 'exit-monitor');
      Sentry.captureException(err, { tags: { module: 'exit-monitor' } });
    }
  }
}

module.exports = new ExitMonitor();
