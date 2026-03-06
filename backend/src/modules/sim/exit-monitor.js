'use strict';

const db = require('../../config/database');
const executor = require('./executor');
const tradeFinalizer = require('./trade-finalizer');
const ledgerService = require('./ledger.service');
const NotificationService = require('../../services/notificationService');
const dataServiceProxy = require('../../services/dataServiceProxy');
const globalMarketState = require('./global-market-state.service');
const marketContext = require('./market-context.service');
const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');

const MIN_HOLD_MS = parseInt(process.env.SIM_MIN_HOLD_MS || '300000', 10);
const REQUIRE_FRESH_PRICE_FOR_EXITS = process.env.SIM_REQUIRE_FRESH_EXIT_PRICE !== 'false';
const MAX_EXIT_PRICE_AGE_MS = parseInt(process.env.SIM_MAX_EXIT_PRICE_AGE_MS || '120000', 10);

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
    // Minimum hold period: skip stop/target evaluation for newly opened positions.
    // Prevents instant stop-outs on stale or estimated prices.
    const holdMs = Date.now() - new Date(position.opened_at).getTime();
    if (holdMs < MIN_HOLD_MS) {
      // Exception: DTE expiry is still checked (position expiring today)
      if (position.expiration && (position.force_close_at_dte_zero !== false)) {
        const dte = Math.ceil((new Date(position.expiration) - Date.now()) / (1000 * 60 * 60 * 24));
        if (dte <= 0) {
          const optionPrice = parseFloat(position.current_price || position.avg_price);
          await this._triggerExit(position, optionPrice, 'DTE_EXPIRY', `Position expired during min-hold (DTE=${dte})`);
          return;
        }
      }
      return;
    }

    const { price: underlyingPrice, fresh: priceFresh, source: priceSource } = await this._getLatestPriceFresh(position);
    if (!underlyingPrice) return;

    // If fresh price is required and we only have stale data, skip evaluation.
    if (REQUIRE_FRESH_PRICE_FOR_EXITS && !priceFresh) {
      const lookupSymbol = position.underlying_symbol || position.symbol;
      logger.warn(
        `[EXIT_SKIP] ${lookupSymbol}: price not fresh (source=${priceSource}) — skipping exit evaluation`,
        'exit-monitor'
      );
      return;
    }

    const isOption = position.contract_type !== 'STOCK';
    const optionResult = isOption
      ? await this._estimateOptionPrice(position, underlyingPrice)
      : { price: underlyingPrice, greeks: null };

    const optionPrice = typeof optionResult === 'number' ? optionResult : optionResult.price;
    const liveGreeks = typeof optionResult === 'object' ? optionResult.greeks : null;

    // Store option price and live Greeks so unrealized PnL and risk are current
    if (isOption && liveGreeks) {
      await db.query(
        `UPDATE sim_positions
         SET current_price = $2,
             live_delta = $3, live_gamma = $4, live_theta = $5,
             live_vega = $6, live_iv = $7, greeks_updated_at = NOW()
         WHERE id = $1`,
        [
          position.id, optionPrice,
          liveGreeks.delta ?? null, liveGreeks.gamma ?? null,
          liveGreeks.theta ?? null, liveGreeks.vega ?? null,
          liveGreeks.iv ?? null,
        ]
      );
    } else {
      await db.query(
        'UPDATE sim_positions SET current_price = $2 WHERE id = $1',
        [position.id, optionPrice]
      );
    }

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
        // Sanity check: a stop-loss exit on a long position should be a loss,
        // and on a credit spread should also be a loss. If the estimated exit
        // price implies a profit, something is wrong with the price estimate —
        // fall back to entry price to avoid phantom P&L.
        const entryPrice = parseFloat(position.avg_price);
        let exitPriceToUse = optionPrice;
        if (!isCreditSpread) {
          const impliedPnl = (optionPrice - entryPrice) * position.quantity * 100;
          if (impliedPnl > 0) {
            logger.warn(
              `[STOP_LOSS_SANITY] ${position.symbol}: stop-loss exit implies profit ` +
              `($${optionPrice} exit vs $${entryPrice} entry = +$${impliedPnl.toFixed(2)}). ` +
              `Price estimate is likely wrong — using entry price as exit.`,
              'exit-monitor'
            );
            exitPriceToUse = entryPrice;
          }
        } else {
          const impliedPnl = (entryPrice - optionPrice) * position.quantity * 100;
          if (impliedPnl > 0) {
            logger.warn(
              `[STOP_LOSS_SANITY] ${position.symbol}: credit spread stop-loss exit implies profit. ` +
              `Price estimate is likely wrong — using entry price as exit.`,
              'exit-monitor'
            );
            exitPriceToUse = entryPrice;
          }
        }
        await this._triggerExit(position, exitPriceToUse, 'STOP_LOSS', `Underlying ${underlyingPrice} breached stop-loss ${stopLoss}`);
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
        // Sanity check: a take-profit exit should be a gain. If the estimated
        // option price implies a loss, the price estimate is stale/wrong —
        // estimate a minimum profit from the underlying move and delta.
        const entryPrice = parseFloat(position.avg_price);
        let tpExitPrice = optionPrice;
        const impliedPnl = isCreditSpread
          ? (entryPrice - tpExitPrice) * position.quantity * 100
          : (tpExitPrice - entryPrice) * position.quantity * 100;

        if (impliedPnl <= 0 && !isCreditSpread) {
          try {
            const intentResult = await db.query(
              `SELECT intent_payload FROM sim_orders
               WHERE webhook_event_id = $1 AND side = 'BUY'
               ORDER BY created_at ASC LIMIT 1`,
              [position.webhook_event_id]
            );
            if (intentResult.rows.length > 0) {
              const intent = typeof intentResult.rows[0].intent_payload === 'string'
                ? JSON.parse(intentResult.rows[0].intent_payload)
                : intentResult.rows[0].intent_payload;
              const underlyingEntry = intent?.limitPrice || intent?.midPrice;
              if (underlyingEntry && underlyingEntry > 0) {
                const delta = Math.abs(parseFloat(position.live_delta || position.delta_at_entry || intent?.delta || 0.50));
                const underlyingMove = profitsWhenDown
                  ? underlyingEntry - underlyingPrice
                  : underlyingPrice - underlyingEntry;
                const estimatedOptionGain = Math.max(0, underlyingMove * delta);
                if (estimatedOptionGain > 0) {
                  tpExitPrice = entryPrice + estimatedOptionGain;
                  logger.warn(
                    `[TP_PRICE_FIX] ${position.symbol}: take-profit implied loss with option estimate $${optionPrice.toFixed(2)} — ` +
                    `corrected exit $${tpExitPrice.toFixed(2)} from delta=${delta.toFixed(3)} × underlying_move=$${underlyingMove.toFixed(2)}`,
                    'exit-monitor'
                  );
                }
              }
            }
          } catch (err) {
            logger.warn(`[TP_PRICE_FIX] ${position.symbol}: lookup failed: ${err.message}`, 'exit-monitor');
          }
        }

        await this._triggerExit(position, tpExitPrice, 'TAKE_PROFIT', `Underlying ${underlyingPrice} reached take-profit ${takeProfit}`);
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

    // 5. Greeks-based exit checks (theta decay + delta collapse)
    if (isOption && liveGreeks) {
      // 5a. Theta decay exit — if daily theta bleed exceeds a threshold
      // percentage of remaining position value, close before time value
      // erodes further. Threshold is configurable; default 5% per day.
      const thetaExitPct = parseFloat(process.env.SIM_THETA_EXIT_PCT || '0.05');
      if (liveGreeks.theta != null && optionPrice > 0) {
        const dailyThetaBleed = Math.abs(liveGreeks.theta);
        const positionValue = optionPrice * position.quantity * 100;
        const thetaRatio = positionValue > 0 ? dailyThetaBleed / positionValue : 0;
        if (thetaRatio > thetaExitPct && positionValue > 0) {
          await this._triggerExit(
            position, optionPrice, 'THETA_DECAY',
            `Daily theta $${dailyThetaBleed.toFixed(2)} = ${(thetaRatio * 100).toFixed(1)}% of position value $${positionValue.toFixed(2)} (threshold ${(thetaExitPct * 100).toFixed(0)}%)`
          );
          return;
        }
      }

      // 5b. Delta collapse — if delta drops below a minimum threshold
      // the option has very little sensitivity to the underlying and
      // is unlikely to recover. Default threshold: |delta| < 0.05.
      const minDelta = parseFloat(process.env.SIM_MIN_DELTA_EXIT || '0.05');
      if (liveGreeks.delta != null) {
        const absDelta = Math.abs(liveGreeks.delta);
        if (absDelta < minDelta && absDelta > 0) {
          const dte = position.expiration
            ? Math.ceil((new Date(position.expiration) - Date.now()) / (1000 * 60 * 60 * 24))
            : 999;
          // Only trigger if DTE > 0 (DTE=0 is handled by expiry check)
          if (dte > 0) {
            await this._triggerExit(
              position, optionPrice, 'DELTA_COLLAPSE',
              `|delta|=${absDelta.toFixed(4)} below minimum ${minDelta} — option is deep OTM with ${dte} DTE remaining`
            );
            return;
          }
        }
      }
    }

    // 6. Max hold duration check (regime-adjusted)
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
   * Get the latest price for a position with freshness metadata.
   * Tries: global_market_state → active fetch → price_cache (stale).
   * Returns { price, fresh, source, ageMs }.
   */
  async _getLatestPriceFresh(position) {
    const lookupSymbol = (position.underlying_symbol || position.symbol).toUpperCase();

    // 1. Check global_market_state (authoritative, shared across users)
    const gms = await globalMarketState.getState(lookupSymbol);
    if (gms?.last_price && gms.price_updated_at) {
      const ageMs = Date.now() - new Date(gms.price_updated_at).getTime();
      if (ageMs <= MAX_EXIT_PRICE_AGE_MS) {
        return { price: parseFloat(gms.last_price), fresh: true, source: 'global_market_state', ageMs };
      }
    }

    // 2. Check price_cache
    const cached = await db.query(
      'SELECT price, updated_at FROM price_cache WHERE symbol = $1',
      [lookupSymbol]
    );
    if (cached.rows.length > 0) {
      const ageMs = Date.now() - new Date(cached.rows[0].updated_at).getTime();
      if (ageMs <= MAX_EXIT_PRICE_AGE_MS) {
        return { price: parseFloat(cached.rows[0].price), fresh: true, source: 'price_cache', ageMs };
      }
    }

    // 3. Active fetch from data-service and update both stores
    try {
      const freshPrice = await globalMarketState.refreshPrice(lookupSymbol);
      if (freshPrice) {
        return { price: freshPrice, fresh: true, source: 'data_service_live', ageMs: 0 };
      }
    } catch (err) {
      logger.warn(`[PRICE_REFRESH] ${lookupSymbol}: live quote failed (${err.message})`, 'exit-monitor');
    }

    // 4. Last resort: return stale price with fresh=false
    const stalePrice = gms?.last_price ? parseFloat(gms.last_price)
      : (cached.rows.length > 0 ? parseFloat(cached.rows[0].price) : null);

    if (stalePrice) {
      const staleAt = gms?.price_updated_at || cached.rows[0]?.updated_at;
      const ageMs = staleAt ? Date.now() - new Date(staleAt).getTime() : Infinity;
      const ageMin = (ageMs / 60000).toFixed(1);
      logger.warn(`[PRICE_STALE] ${lookupSymbol}: using stale $${stalePrice} (${ageMin}min old) — all live sources failed`, 'exit-monitor');
      return { price: stalePrice, fresh: false, source: 'stale_cache', ageMs };
    }

    return { price: null, fresh: false, source: 'none', ageMs: Infinity };
  }

  /**
   * Legacy wrapper for backward compatibility.
   */
  async _getLatestPrice(position) {
    const result = await this._getLatestPriceFresh(position);
    return result.price;
  }

  /**
   * Estimate the current option price and live Greeks for a position.
   * Tries live chain data first, falls back to intrinsic value.
   * @returns {{ price: number, greeks: Object|null }}
   */
  async _estimateOptionPrice(position, underlyingPrice) {
    const lookupSymbol = position.underlying_symbol || position.symbol;

    // Try live chain data from the data service
    try {
      const chainData = await dataServiceProxy.getOptionsChain(
        lookupSymbol,
        position.expiration
      );
      if (chainData?.data?.contracts) {
        const targetType = position.contract_type === 'PUT' ? 'put' : 'call';
        const match = chainData.data.contracts.find(c =>
          parseFloat(c.strike) === parseFloat(position.strike)
          && c.type?.toLowerCase() === targetType
        );
        if (match) {
          const greeks = {
            delta: match.delta ?? null,
            gamma: match.gamma ?? null,
            theta: match.theta ?? null,
            vega: match.vega ?? null,
            iv: match.iv ?? match.impliedVolatility ?? null,
          };
          if (match.mid && match.mid > 0) {
            logger.info(
              `[OPTION_PRICE] ${position.symbol}: chain mid=$${match.mid} ` +
              `Δ=${greeks.delta?.toFixed(3) ?? '?'} Γ=${greeks.gamma?.toFixed(4) ?? '?'} ` +
              `Θ=${greeks.theta?.toFixed(3) ?? '?'} V=${greeks.vega?.toFixed(3) ?? '?'}`,
              'exit-monitor'
            );
            return { price: match.mid, greeks };
          }
          if (match.last && match.last > 0) {
            logger.info(`[OPTION_PRICE] ${position.symbol}: chain last=$${match.last} (no mid)`, 'exit-monitor');
            return { price: match.last, greeks };
          }
          logger.warn(`[OPTION_PRICE] ${position.symbol}: chain match found but mid=${match.mid} last=${match.last} — both zero/null`, 'exit-monitor');
        } else {
          logger.warn(`[OPTION_PRICE] ${position.symbol}: no chain match for strike=${position.strike} type=${targetType} in ${chainData.data.contracts.length} contracts`, 'exit-monitor');
        }
      }
    } catch (err) {
      logger.warn(`[OPTION_PRICE] ${position.symbol}: chain fetch failed for ${lookupSymbol} (${err.message})`, 'exit-monitor');
    }

    const strike = parseFloat(position.strike);
    if (!strike || isNaN(strike)) return { price: parseFloat(position.avg_price), greeks: null };

    const dte = position.expiration
      ? Math.max(0, (new Date(position.expiration) - Date.now()) / (1000 * 60 * 60 * 24))
      : 0;

    // Intrinsic fallback: disabled returns entry price which makes ALL exits
    // show ~0% PnL regardless of underlying movement. This defeats the purpose
    // of the simulator. Default to enabled so exits reflect real price movement.
    const allowIntrinsicFallback = process.env.SIM_ALLOW_INTRINSIC_FALLBACK !== 'false';
    if (!allowIntrinsicFallback) {
      logger.warn(
        `[PRICE_FALLBACK_BLOCKED] ${position.symbol}: chain unavailable and intrinsic fallback disabled — using entry price as exit estimate`,
        'exit-monitor'
      );
      return { price: parseFloat(position.avg_price), greeks: null, source: 'entry_price_fallback' };
    }

    logger.warn(
      `[PRICE_FALLBACK] ${position.symbol}: chain unavailable, using intrinsic+extrinsic estimate (underlying=${underlyingPrice}, strike=${strike}, dte=${dte.toFixed(1)})`,
      'exit-monitor'
    );

    const entryPrice = parseFloat(position.avg_price);

    if (position.contract_type === 'CALL') {
      const intrinsic = Math.max(0, underlyingPrice - strike);
      const extrinsic = this._estimateExtrinsicValue(underlyingPrice, strike, dte);
      let estimated = Math.max(0.01, intrinsic + extrinsic);
      // Cap the estimated price change to a realistic max per DTE.
      // Options rarely move more than 10x entry in < 30 DTE without chain confirmation.
      const maxReasonablePrice = entryPrice * 10;
      if (estimated > maxReasonablePrice && !position.greeks_updated_at) {
        logger.warn(
          `[PRICE_CAP] ${position.symbol}: estimated $${estimated.toFixed(2)} capped to $${maxReasonablePrice.toFixed(2)} ` +
          `(10x entry $${entryPrice}) — no live chain confirmation`,
          'exit-monitor'
        );
        estimated = maxReasonablePrice;
      }
      return { price: estimated, greeks: null };
    }
    if (position.contract_type === 'PUT') {
      const intrinsic = Math.max(0, strike - underlyingPrice);
      const extrinsic = this._estimateExtrinsicValue(underlyingPrice, strike, dte);
      let estimated = Math.max(0.01, intrinsic + extrinsic);
      const maxReasonablePrice = entryPrice * 10;
      if (estimated > maxReasonablePrice && !position.greeks_updated_at) {
        logger.warn(
          `[PRICE_CAP] ${position.symbol}: estimated $${estimated.toFixed(2)} capped to $${maxReasonablePrice.toFixed(2)} ` +
          `(10x entry $${entryPrice}) — no live chain confirmation`,
          'exit-monitor'
        );
        estimated = maxReasonablePrice;
      }
      return { price: estimated, greeks: null };
    }
    if (position.contract_type === 'CREDIT_SPREAD') {
      const shortStrike = parseFloat(position.strike_short || position.strike);
      const longStrike = parseFloat(position.strike_long);
      if (!isNaN(shortStrike) && !isNaN(longStrike)) {
        const isCallSpread = shortStrike < longStrike;
        let shortIntrinsic, longIntrinsic;
        if (isCallSpread) {
          shortIntrinsic = Math.max(0, underlyingPrice - shortStrike);
          longIntrinsic = Math.max(0, underlyingPrice - longStrike);
        } else {
          shortIntrinsic = Math.max(0, shortStrike - underlyingPrice);
          longIntrinsic = Math.max(0, longStrike - underlyingPrice);
        }
        const spreadValue = Math.max(0, shortIntrinsic - longIntrinsic);
        const extrinsicEstimate = dte > 0 ? 0.02 * Math.sqrt(dte) : 0;
        return { price: Math.max(0.01, spreadValue + extrinsicEstimate), greeks: null };
      }
    }

    return { price: parseFloat(position.avg_price), greeks: null };
  }

  /**
   * Rough extrinsic (time) value estimate when chain data is unavailable.
   * Uses a simplified model: extrinsic decays with sqrt(DTE) and is
   * proportional to how close the option is to ATM.
   */
  _estimateExtrinsicValue(underlyingPrice, strike, dte) {
    if (dte <= 0) return 0;
    const moneyness = Math.abs(underlyingPrice - strike) / underlyingPrice;
    const atmExtrinsic = underlyingPrice * 0.01 * Math.sqrt(dte / 30);
    const otmDecay = Math.exp(-5 * moneyness);
    return Math.max(0, atmExtrinsic * otmDecay);
  }

  async _triggerExit(position, exitPrice, reason, message) {
    // Suspicious exit detection
    const holdMs = Date.now() - new Date(position.opened_at).getTime();
    const holdSec = holdMs / 1000;
    const entryPrice = parseFloat(position.avg_price);
    const multiplier = position.contract_type === 'STOCK' ? 1 : 100;
    const impliedPnl = position.contract_type === 'CREDIT_SPREAD'
      ? (entryPrice - exitPrice) * position.quantity * multiplier
      : (exitPrice - entryPrice) * position.quantity * multiplier;
    const impliedPnlPct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;

    let exitAnomalyReason = null;
    if (holdSec < 60 && reason !== 'DTE_EXPIRY') {
      exitAnomalyReason = `RAPID_EXIT: position held only ${holdSec.toFixed(0)}s`;
      logger.warn(
        `[EXIT_ANOMALY] ${position.symbol}: ${exitAnomalyReason} — PnL $${impliedPnl.toFixed(2)} (${impliedPnlPct.toFixed(1)}%)`,
        'exit-monitor'
      );
    }
    if (Math.abs(impliedPnlPct) > 50 && reason === 'STOP_LOSS') {
      const msg = `EXTREME_STOP: ${impliedPnlPct.toFixed(1)}% move on stop-loss — pricing may be unreliable`;
      exitAnomalyReason = exitAnomalyReason ? `${exitAnomalyReason}; ${msg}` : msg;
      logger.warn(`[EXIT_ANOMALY] ${position.symbol}: ${msg}`, 'exit-monitor');
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const check = await client.query(
        'SELECT status FROM sim_positions WHERE id = $1 FOR UPDATE',
        [position.id]
      );
      if (check.rows.length === 0 || check.rows[0].status !== 'OPEN') {
        await client.query('COMMIT');
        logger.info(`Exit skipped for ${position.id}: position is no longer OPEN`, 'exit-monitor');
        return;
      }

      await client.query('COMMIT');

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
        }).catch(err => logger.warn(`Exit notification failed: ${err.message}`, 'exit-monitor'));
      }

      this._exitsTriggered++;
      logger.info(`EXIT TRIGGERED [${reason}]: ${position.symbol} @ ${exitPrice} — ${message}`, 'exit-monitor');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.message?.includes('no longer OPEN') || error.message?.includes('already closed')) {
        logger.info(`Exit race resolved for ${position.id}: ${error.message}`, 'exit-monitor');
        return;
      }
      logger.error(`Exit trigger failed for ${position.id}: ${error.message}`, 'exit-monitor');
      Sentry.captureException(error, { tags: { module: 'exit-monitor' } });
    } finally {
      client.release();
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
