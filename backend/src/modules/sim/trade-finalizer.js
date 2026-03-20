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
   * @param {Object} [opts] - Optional: { backtestRunId } — when set, skips scorecard/adaptive updates
   * @returns {Promise<Object>} The created sim_trade record
   */
  async finalize(position, exitPrice, userId, opts = {}) {
    const { backtestRunId } = opts;
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

    // P&L percent and MAE/MFE denominator: use max_risk_per_spread (Fix 3).
    // For credit spreads: max loss = spread width - credit.
    // For debit spreads / single-leg: use intent.maxLoss when available, else net debit/premium.
    let capitalBase = await this._getMaxRiskCapitalBase(position, entryPrice, quantity, multiplier);
    const pnlPercent = capitalBase !== 0 ? (pnl / capitalBase) * 100 : 0;

    // Validate P&L calculations for sanity
    await this._validatePnlCalculations(position, entryPrice, exitPrice, pnl, pnlPercent, capitalBase);

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

    // Look up regime at entry time
    const { regimeAtEntry, regimeSource } = await this._lookupRegimeAtEntry(
      position.underlying_symbol || position.symbol, position.opened_at
    );

    // Compute MAE/MFE as fraction of entry cost basis
    const maeMfe = await this._computeSimMaeMfe(position, entryPrice, exitPrice, side, capitalBase);

    const id = uuidv4();
    const result = await db.query(
      `INSERT INTO sim_trades (
        id, user_id, position_id, symbol, underlying_symbol, contract_type,
        side, strategy, strike, strike_short, strike_long, expiration,
        entry_price, exit_price, quantity, contract_multiplier,
        entry_time, exit_time, pnl, pnl_percent, r_multiple,
        commission_total, dte_at_entry, delta_at_entry,
        is_sim, webhook_event_id, stop_source, exit_reason,
        regime_at_entry, regime_source,
        max_adverse_excursion, max_favorable_excursion,
        backtest_run_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, TRUE, $25, $26, $27,
        $28, $29, $30, $31, $32
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
        regimeAtEntry, regimeSource,
        maeMfe.mae, maeMfe.mfe,
        backtestRunId || null,
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

    // Take an equity snapshot after each trade closes (skip for backtest)
    if (!backtestRunId) {
      await ledgerService.takeEquitySnapshot(userId);
    }

    // Recalculate strategy scorecard after each trade (Phase 1)
    // Update adaptive cooldowns (Phase 4) — skip for backtest runs
    if (!backtestRunId && position.strategy) {
      try {
        await strategyScorecardService.recalculate(userId, position.strategy);
        await adaptiveGuards.recordTradeResult(userId, position.strategy, pnl);
      } catch (err) {
        logger.error(`Intelligence layer post-trade update failed: ${err.message}`, 'sim-finalizer');
        Sentry.captureException(err, { tags: { module: 'sim-finalizer' } });
      }
    }

    // Increment calibration trade counter and auto-calibrate if enabled + threshold met — skip for backtest
    if (!backtestRunId) {
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
    }

    logger.info(
      `Trade finalized: ${position.symbol} ${position.contract_type} PnL=$${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`,
      'sim-finalizer'
    );

    const PRIORITY_STRATEGIES = ['STRAT_FAILED2', 'REVERSAL_2-2-2_CONT_DOWN', 'ORB_BREAKOUT'];
    if (PRIORITY_STRATEGIES.includes((position.strategy || '').toUpperCase())) {
      logger.info(
        `[PRIORITY_TRADE] ${position.strategy}: symbol=${position.symbol} ` +
        `entry=${entryPrice} exit=${exitPrice} PnL=$${pnl.toFixed(2)} ` +
        `regime=${regimeAtEntry || 'UNKNOWN'} (source=${regimeSource}) ` +
        `DTE=${dteAtEntry} delta=${position.delta_at_entry} ` +
        `MAE=${maeMfe.mae != null ? (maeMfe.mae * 100).toFixed(1) + '%' : 'N/A'} ` +
        `MFE=${maeMfe.mfe != null ? (maeMfe.mfe * 100).toFixed(1) + '%' : 'N/A'} ` +
        `session=${position.opened_at}`,
        'sim-finalizer'
      );
    }

    return trade;
  }

  /**
   * Fix 3: Compute max risk (denominator for MAE/MFE and pnl_percent).
   * Uses intent.maxLoss when available; otherwise spread width - credit or net debit.
   */
  async _getMaxRiskCapitalBase(position, entryPrice, quantity, multiplier) {
    if (position.contract_type === 'CREDIT_SPREAD') {
      const spreadWidth = Math.abs(
        (parseFloat(position.strike_short) || 0) - (parseFloat(position.strike_long) || 0)
      );
      return (spreadWidth - entryPrice) * quantity * multiplier;
    }

    // Debit trades: prefer intent.maxLoss (dollar risk per contract) — most accurate
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
      if (intent?.maxLoss && intent.maxLoss > 0) {
        return intent.maxLoss * quantity;
      }
    }

    // Fallback: net debit for debit spread, premium for single-leg
    return entryPrice * quantity * multiplier;
  }

  async _lookupRegimeAtEntry(symbol, entryTime) {
    try {
      const vsResult = await db.query(
        `SELECT regime FROM volatility_snapshots
         WHERE symbol = $1 AND captured_at <= $2
         ORDER BY captured_at DESC LIMIT 1`,
        [symbol, entryTime]
      );
      if (vsResult.rows.length > 0 && vsResult.rows[0].regime) {
        return { regimeAtEntry: vsResult.rows[0].regime, regimeSource: 'volatility_snapshot' };
      }

      const ivResult = await db.query(
        `SELECT iv_rank FROM iv_snapshots
         WHERE symbol = $1 AND captured_at <= $2
         ORDER BY captured_at DESC LIMIT 1`,
        [symbol, entryTime]
      );
      if (ivResult.rows.length > 0 && ivResult.rows[0].iv_rank != null) {
        const ivRank = parseFloat(ivResult.rows[0].iv_rank);
        let regime;
        if (ivRank > 80) regime = 'HIGH_VOL_EXPANSION';
        else if (ivRank > 60) regime = 'ELEVATED_VOL';
        else if (ivRank > 40) regime = 'NEUTRAL';
        else if (ivRank > 20) regime = 'LOW_VOL';
        else regime = 'LOW_VOL_CHOP';
        return { regimeAtEntry: regime, regimeSource: 'iv_rank_fallback' };
      }

      // Fix 1: Default to NEUTRAL when volatility_snapshots/iv_snapshots unavailable
      // Prevents UNKNOWN cascade in regime-edge analytics
      return { regimeAtEntry: 'NEUTRAL', regimeSource: 'regime_staleness_fallback' };
    } catch (err) {
      logger.warn(`Regime lookup at entry failed: ${err.message}`, 'sim-finalizer');
      return { regimeAtEntry: null, regimeSource: null };
    }
  }

  async _computeSimMaeMfe(position, entryPrice, exitPrice, side, capitalBase) {
    try {
      if (!position.highest_price || !position.lowest_price || capitalBase <= 0) {
        return { mae: null, mfe: null };
      }

      const highest = parseFloat(position.highest_price);
      const lowest = parseFloat(position.lowest_price);
      const multiplier = position.contract_type === 'STOCK' ? 1 : CONTRACT_MULTIPLIER;
      const qty = position.quantity;

      let maeDollar, mfeDollar;
      if (side === 'long') {
        maeDollar = Math.abs(Math.min(0, (lowest - entryPrice))) * qty * multiplier;
        mfeDollar = Math.abs(Math.max(0, (highest - entryPrice))) * qty * multiplier;
      } else {
        maeDollar = Math.abs(Math.max(0, (highest - entryPrice))) * qty * multiplier;
        mfeDollar = Math.abs(Math.min(0, (lowest - entryPrice))) * qty * multiplier;
      }

      const mae = capitalBase > 0 ? Math.round((maeDollar / capitalBase) * 10000) / 10000 : null;
      const mfe = capitalBase > 0 ? Math.round((mfeDollar / capitalBase) * 10000) / 10000 : null;

      // Fix 3: MAE_MFE_SANITY_CAP_PCT = 200 — values >200% indicate denominator/unit error
      const MAE_MFE_SANITY_CAP = parseFloat(process.env.MAE_MFE_SANITY_CAP_PCT || '200') / 100;
      if (mae != null && (mae < 0 || mae > MAE_MFE_SANITY_CAP)) {
        logger.warn(
          `[CALCULATION_ANOMALY] MAE=${(mae * 100).toFixed(1)}% out of bounds [0, ${MAE_MFE_SANITY_CAP * 100}%] — ` +
          `position ${position.id} symbol=${position.symbol} maeDollar=${maeDollar} capitalBase=${capitalBase}. Excluding from record.`,
          'sim-finalizer'
        );
        return { mae: null, mfe };
      }
      if (mfe != null && (mfe < 0 || mfe > MAE_MFE_SANITY_CAP)) {
        logger.warn(
          `[CALCULATION_ANOMALY] MFE=${(mfe * 100).toFixed(1)}% out of bounds [0, ${MAE_MFE_SANITY_CAP * 100}%] — ` +
          `position ${position.id} symbol=${position.symbol} mfeDollar=${mfeDollar} capitalBase=${capitalBase}. Excluding from record.`,
          'sim-finalizer'
        );
        return { mae, mfe: null };
      }

      return { mae, mfe };
    } catch (err) {
      logger.warn(`MAE/MFE computation failed: ${err.message}`, 'sim-finalizer');
      return { mae: null, mfe: null };
    }
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

    // Debit trades: use maxLoss from order intent (dollar risk per contract),
    // NOT |optionPrice - underlyingStopLevel| which mixes price domains.
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

      // Prefer maxLoss (dollar risk per contract, already in correct units)
      if (intent.maxLoss && intent.maxLoss > 0) {
        const totalRisk = intent.maxLoss * position.quantity;
        if (totalRisk > 0) {
          return Math.round((pnl / totalRisk) * 10000) / 10000;
        }
      }

      // Fallback: compute from stop distance on the UNDERLYING, then scale
      // by delta to approximate option risk (not exact but better than mixing domains)
      if (intent.stopLoss) {
        const entryUnderlying = intent.limitPrice || intent.midPrice;
        if (entryUnderlying && entryUnderlying > 0) {
          const underlyingRisk = Math.abs(entryUnderlying - intent.stopLoss);
          const delta = Math.abs(intent.delta || position.delta_at_entry || 0.50);
          const optionRisk = underlyingRisk * delta;
          const totalRisk = optionRisk * position.quantity * multiplier;
          if (totalRisk > 0) {
            return Math.round((pnl / totalRisk) * 10000) / 10000;
          }
        }
      }
    }

    return null;
  }

  /**
   * Validate P&L calculations for sanity and consistency
   * Checks:
   * 1. Entry price is reasonable (positive and within typical bounds)
   * 2. Exit price is reasonable (positive and within typical bounds)
   * 3. P&L magnitude is not unrealistic (e.g., -100% loss on debit)
   * 4. P&L sign matches contract type and price movement
   * 5. Capital base is reasonable for the position
   */
  async _validatePnlCalculations(position, entryPrice, exitPrice, pnl, pnlPercent, capitalBase) {
    const warnings = [];
    const DEBIT_LOSS_LIMIT = -100; // Debit positions shouldn't lose > 100%
    const CREDIT_GAIN_LIMIT = 100;  // Credit positions shouldn't gain > 100%
    const PRICE_SANITY_MAX = 100000; // Max reasonable price

    // Check 1: Entry price sanity
    if (entryPrice <= 0 || entryPrice > PRICE_SANITY_MAX) {
      warnings.push(`Invalid entry price: ${entryPrice}`);
    }

    // Check 2: Exit price sanity
    if (exitPrice <= 0 || exitPrice > PRICE_SANITY_MAX) {
      warnings.push(`Invalid exit price: ${exitPrice}`);
    }

    // Check 3: P&L magnitude check
    const multiplier = position.contract_type === 'STOCK' ? 1 : CONTRACT_MULTIPLIER;
    const maxAbsP = Math.abs(capitalBase) * 2; // Allow up to 200% P&L magnitude
    if (Math.abs(pnl) > maxAbsP && capitalBase > 0) {
      warnings.push(`Unrealistic P&L magnitude: $${pnl.toFixed(2)} vs capital base $${capitalBase.toFixed(2)}`);
    }

    // Check 4: P&L sign sanity
    if (position.contract_type === 'CREDIT_SPREAD') {
      if (exitPrice > entryPrice && pnl > 0) {
        warnings.push(`Credit spread: exit price increased but P&L is positive (should be loss)`);
      }
      if (pnlPercent < DEBIT_LOSS_LIMIT) {
        warnings.push(`Credit spread P&L below realistic loss limit: ${pnlPercent.toFixed(2)}%`);
      }
    } else {
      // Debit position
      if (exitPrice > entryPrice && pnl <= 0) {
        warnings.push(`Debit position: exit price higher than entry, but P&L is non-positive`);
      }
      if (exitPrice < entryPrice && pnl >= 0) {
        warnings.push(`Debit position: exit price lower than entry, but P&L is non-negative`);
      }
      if (pnlPercent < DEBIT_LOSS_LIMIT) {
        warnings.push(`Debit position P&L below realistic loss limit: ${pnlPercent.toFixed(2)}%`);
      }
    }

    // Check 5: Capital base sanity
    if (capitalBase <= 0 && position.contract_type !== 'CREDIT_SPREAD') {
      warnings.push(`Non-positive capital base: ${capitalBase} (may indicate data issue)`);
    }

    // Log warnings if any detected
    if (warnings.length > 0) {
      const details = `${position.symbol} ${position.contract_type} entry=$${entryPrice.toFixed(2)} exit=$${exitPrice.toFixed(2)} pnl=$${pnl.toFixed(2)} pnlPercent=${pnlPercent.toFixed(2)}%`;
      warnings.forEach(w => {
        logger.warn(`[PnL_VALIDATION] ${w} | ${details}`, 'sim-finalizer');
      });
      
      // Track validation failures in Sentry for monitoring
      if (warnings.length > 2) {
        Sentry.captureMessage(`Multiple P&L sanity check failures: ${warnings.join('; ')}`, {
          level: 'warning',
          tags: { module: 'sim-finalizer', type: 'pnl-validation' },
          contexts: {
            position: {
              symbol: position.symbol,
              contract_type: position.contract_type,
              entry_price: entryPrice,
              exit_price: exitPrice,
              pnl: pnl,
              pnl_percent: pnlPercent,
            },
          },
        });
      }
    }
  }
}

module.exports = new TradeFinalizerService();
