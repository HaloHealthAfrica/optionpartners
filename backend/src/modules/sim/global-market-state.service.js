'use strict';

const db = require('../../config/database');
const dataServiceProxy = require('../../services/dataServiceProxy');
const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');

const STALENESS = {
  PRICE_MARKET_HOURS_MS: parseInt(process.env.GMS_PRICE_STALE_MARKET_MS || '60000', 10),
  PRICE_OFF_HOURS_MS: parseInt(process.env.GMS_PRICE_STALE_OFF_MS || '600000', 10),
  CHAIN_MARKET_HOURS_MS: parseInt(process.env.GMS_CHAIN_STALE_MARKET_MS || '300000', 10),
  CHAIN_OFF_HOURS_MS: parseInt(process.env.GMS_CHAIN_STALE_OFF_MS || '1800000', 10),
};

function isMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const hour = et.getHours();
  const min = et.getMinutes();
  const mins = hour * 60 + min;
  return mins >= 570 && mins <= 960; // 9:30 - 16:00 ET
}

class GlobalMarketStateService {
  /**
   * Get the global market state for a symbol.
   */
  async getState(symbol) {
    const result = await db.query(
      'SELECT * FROM global_market_state WHERE symbol = $1',
      [symbol.toUpperCase()]
    );
    return result.rows[0] || null;
  }

  /**
   * Check whether price data is fresh enough for decisions.
   */
  isPriceFresh(state) {
    if (!state?.price_updated_at) return false;
    const ageMs = Date.now() - new Date(state.price_updated_at).getTime();
    const maxAge = isMarketHours() ? STALENESS.PRICE_MARKET_HOURS_MS : STALENESS.PRICE_OFF_HOURS_MS;
    return ageMs <= maxAge;
  }

  /**
   * Check whether chain data is fresh enough for decisions.
   */
  isChainFresh(state) {
    if (!state?.chain_updated_at) return false;
    const ageMs = Date.now() - new Date(state.chain_updated_at).getTime();
    const maxAge = isMarketHours() ? STALENESS.CHAIN_MARKET_HOURS_MS : STALENESS.CHAIN_OFF_HOURS_MS;
    return ageMs <= maxAge;
  }

  /**
   * Get staleness info for logging/auditing.
   */
  getStalenessInfo(state) {
    const now = Date.now();
    const priceAge = state?.price_updated_at
      ? Math.round((now - new Date(state.price_updated_at).getTime()) / 1000)
      : null;
    const chainAge = state?.chain_updated_at
      ? Math.round((now - new Date(state.chain_updated_at).getTime()) / 1000)
      : null;
    const mktHrs = isMarketHours();
    return {
      priceAgeSeconds: priceAge,
      chainAgeSeconds: chainAge,
      priceFresh: this.isPriceFresh(state),
      chainFresh: this.isChainFresh(state),
      isMarketHours: mktHrs,
    };
  }

  /**
   * Refresh price for a symbol from the data-service.
   * Skips the API call if existing data is still fresh.
   */
  async refreshPrice(symbol, { force = false } = {}) {
    const sym = symbol.toUpperCase();

    if (!force) {
      const existing = await this.getState(sym);
      if (this.isPriceFresh(existing)) {
        return existing.last_price ? parseFloat(existing.last_price) : null;
      }
    }

    try {
      const quote = await dataServiceProxy.getQuote(sym);
      const price = parseFloat(quote?.data?.price ?? quote?.data?.last ?? quote?.data?.close);
      if (!price || isNaN(price)) {
        await this._recordFailure(sym, 'price', 'No price in response');
        return null;
      }

      // Price plausibility check: compare against last known price if available.
      // A >50% intraday move is extremely unusual and likely a data error.
      const existing = !force ? null : await this.getState(sym);
      const lastKnown = existing?.last_price ? parseFloat(existing.last_price) : null;
      if (lastKnown && lastKnown > 0) {
        const changePct = Math.abs((price - lastKnown) / lastKnown);
        if (changePct > 0.50) {
          logger.warn(
            `[GMS_PRICE_SUSPECT] ${sym}: new price $${price} is ${(changePct * 100).toFixed(1)}% different from last known $${lastKnown} — possible data error`,
            'global-market-state'
          );
        }
      }

      const high = parseFloat(quote?.data?.high) || null;
      const low = parseFloat(quote?.data?.low) || null;
      const open = parseFloat(quote?.data?.open) || null;
      const volume = parseInt(quote?.data?.volume, 10) || null;

      await db.query(
        `INSERT INTO global_market_state (symbol, last_price, price_high, price_low, price_open, price_volume, price_source, price_updated_at, price_fetch_failures, last_price_error, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'data_service', NOW(), 0, NULL, NOW())
         ON CONFLICT (symbol) DO UPDATE SET
           last_price = $2, price_high = COALESCE($3, global_market_state.price_high),
           price_low = COALESCE($4, global_market_state.price_low),
           price_open = COALESCE($5, global_market_state.price_open),
           price_volume = COALESCE($6, global_market_state.price_volume),
           price_source = 'data_service', price_updated_at = NOW(),
           price_fetch_failures = 0, last_price_error = NULL, updated_at = NOW()`,
        [sym, price, high, low, open, volume]
      );

      // Also update price_cache for backward compatibility
      await db.query(
        `INSERT INTO price_cache (symbol, price, volume, high, low, open, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (symbol) DO UPDATE SET
           price = $2, volume = COALESCE($3, price_cache.volume),
           high = COALESCE($4, price_cache.high), low = COALESCE($5, price_cache.low),
           open = COALESCE($6, price_cache.open), updated_at = NOW()`,
        [sym, price, volume, high, low, open]
      );

      logger.info(`[GMS] ${sym}: price refreshed $${price}`, 'global-market-state');
      return price;
    } catch (err) {
      await this._recordFailure(sym, 'price', err.message);
      logger.error(`[GMS] ${sym}: price refresh failed: ${err.message}`, 'global-market-state');
      return null;
    }
  }

  /**
   * Refresh options chain for a symbol from the data-service.
   * Skips the API call if existing data is still fresh.
   */
  async refreshChain(symbol, { force = false } = {}) {
    const sym = symbol.toUpperCase();

    // Only fetch chains for core ETFs that the data-service poller caches.
    // Individual stock chains are too credit-expensive (~500 credits each on TD).
    const CHAIN_SYMBOLS = (process.env.GMS_CHAIN_SYMBOLS || 'SPY,QQQ,IWM').split(',').map(s => s.trim().toUpperCase());
    if (!CHAIN_SYMBOLS.includes(sym)) {
      return { skipped: true, reason: 'not_in_chain_symbols' };
    }

    if (!force) {
      const existing = await this.getState(sym);
      if (this.isChainFresh(existing)) {
        return existing.chain_ok ? { skipped: true } : null;
      }
    }

    const maxRetries = parseInt(process.env.GMS_CHAIN_MAX_RETRIES || '3', 10);
    let chainData = null;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        chainData = await dataServiceProxy.getOptionsChain(sym);
        if (chainData) break;
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
          logger.warn(`[GMS] ${sym}: chain attempt ${attempt}/${maxRetries} failed (${err.message}), retrying in ${delayMs}ms`, 'global-market-state');
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }

    if (!chainData && lastErr) {
      await this._recordFailure(sym, 'chain', lastErr.message);
      logger.error(`[GMS] ${sym}: chain refresh failed after ${maxRetries} attempts: ${lastErr.message}`, 'global-market-state');
      return null;
    }

    try {
      const contracts = chainData?.data?.contracts || [];

      if (contracts.length === 0) {
        await this._recordFailure(sym, 'chain', 'Empty contracts array');
        // Still update timestamp so we know we checked
        await db.query(
          `INSERT INTO global_market_state (symbol, chain_ok, chain_contracts_count, chain_updated_at, updated_at)
           VALUES ($1, FALSE, 0, NOW(), NOW())
           ON CONFLICT (symbol) DO UPDATE SET
             chain_ok = FALSE, chain_contracts_count = 0,
             chain_updated_at = NOW(), updated_at = NOW()`,
          [sym]
        );
        return null;
      }

      let totalOI = 0, totalVol = 0, spreadSum = 0, spreadCount = 0;
      for (const c of contracts) {
        totalOI += parseInt(c.openInterest || c.oi || 0, 10);
        totalVol += parseInt(c.volume || c.vol || 0, 10);
        if (c.bid != null && c.ask != null && c.mid > 0) {
          spreadSum += (c.ask - c.bid) / c.mid;
          spreadCount++;
        }
      }

      const avgSpread = spreadCount > 0 ? Math.round((spreadSum / spreadCount) * 10000) / 10000 : null;
      const liquidityOk = totalOI >= 100 && totalVol >= 10;
      const ivPercentile = parseFloat(chainData?.data?.iv_percentile) || null;

      await db.query(
        `INSERT INTO global_market_state (symbol, chain_ok, chain_contracts_count, chain_open_interest, chain_volume, bid_ask_spread_pct, liquidity_ok, iv_percentile, chain_source, chain_updated_at, chain_fetch_failures, last_chain_error, updated_at)
         VALUES ($1, TRUE, $2, $3, $4, $5, $6, $7, 'data_service', NOW(), 0, NULL, NOW())
         ON CONFLICT (symbol) DO UPDATE SET
           chain_ok = TRUE, chain_contracts_count = $2,
           chain_open_interest = $3, chain_volume = $4,
           bid_ask_spread_pct = $5, liquidity_ok = $6,
           iv_percentile = COALESCE($7, global_market_state.iv_percentile),
           chain_source = 'data_service', chain_updated_at = NOW(),
           chain_fetch_failures = 0, last_chain_error = NULL, updated_at = NOW()`,
        [sym, contracts.length, totalOI, totalVol, avgSpread, liquidityOk, ivPercentile]
      );

      logger.info(
        `[GMS] ${sym}: chain refreshed — ${contracts.length} contracts, OI=${totalOI}, vol=${totalVol}, spread=${avgSpread}, liq=${liquidityOk}`,
        'global-market-state'
      );

      return { contracts, totalOI, totalVol, avgSpread, liquidityOk };
    } catch (err) {
      await this._recordFailure(sym, 'chain', err.message);
      logger.error(`[GMS] ${sym}: chain refresh failed: ${err.message}`, 'global-market-state');
      return null;
    }
  }

  /**
   * Refresh both price and chain for a symbol.
   * Freshness checks prevent redundant API calls when data-service pollers
   * have already updated the data recently.
   */
  async refreshAll(symbol, opts = {}) {
    const [price, chain] = await Promise.allSettled([
      this.refreshPrice(symbol, opts),
      this.refreshChain(symbol, opts),
    ]);
    return {
      price: price.status === 'fulfilled' ? price.value : null,
      chain: chain.status === 'fulfilled' ? chain.value : null,
    };
  }

  /**
   * Refresh all tracked symbols. Called by the periodic poller.
   * Freshness checks prevent duplicate API calls when data-service pollers
   * are already keeping the cache warm.
   */
  async refreshAllSymbols() {
    const mktHrs = isMarketHours();
    const result = await db.query('SELECT symbol FROM global_market_state ORDER BY symbol');
    const symbols = result.rows.map(r => r.symbol);

    const results = {};
    let skipped = 0;
    let refreshed = 0;

    for (const sym of symbols) {
      const res = await this.refreshAll(sym);
      results[sym] = res;

      const priceSkipped = res.price !== null && typeof res.price === 'number';
      const chainSkipped = res.chain?.skipped;
      if (priceSkipped || chainSkipped) skipped++;
      else refreshed++;

      if (mktHrs) {
        await new Promise(r => setTimeout(r, 500));
      } else {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    logger.info(
      `[GMS] Refresh complete: ${refreshed} fetched, ${skipped} skipped (fresh), ${symbols.length} total`,
      'global-market-state'
    );

    return results;
  }

  /**
   * Get a health summary for all tracked symbols.
   */
  async getHealthSummary() {
    const result = await db.query(`
      SELECT symbol, last_price, price_updated_at, chain_ok, chain_contracts_count,
             chain_updated_at, price_fetch_failures, chain_fetch_failures,
             last_price_error, last_chain_error
      FROM global_market_state
      ORDER BY symbol
    `);

    return result.rows.map(row => ({
      symbol: row.symbol,
      price: {
        value: row.last_price ? parseFloat(row.last_price) : null,
        updatedAt: row.price_updated_at,
        ageSeconds: row.price_updated_at
          ? Math.round((Date.now() - new Date(row.price_updated_at).getTime()) / 1000)
          : null,
        fresh: this.isPriceFresh(row),
        failures: row.price_fetch_failures,
        lastError: row.last_price_error,
      },
      chain: {
        ok: row.chain_ok,
        contracts: row.chain_contracts_count,
        updatedAt: row.chain_updated_at,
        ageSeconds: row.chain_updated_at
          ? Math.round((Date.now() - new Date(row.chain_updated_at).getTime()) / 1000)
          : null,
        fresh: this.isChainFresh(row),
        failures: row.chain_fetch_failures,
        lastError: row.last_chain_error,
      },
    }));
  }

  /**
   * Detect dead feeds and return alerts.
   */
  async detectDeadFeeds() {
    const mktHrs = isMarketHours();
    if (!mktHrs) return []; // Don't alert outside market hours

    const result = await db.query(`
      SELECT symbol, price_updated_at, chain_updated_at,
             price_fetch_failures, chain_fetch_failures
      FROM global_market_state
      WHERE symbol IN ('SPY', 'QQQ', 'IWM')
      ORDER BY symbol
    `);

    const alerts = [];
    const now = Date.now();
    for (const row of result.rows) {
      const priceAge = row.price_updated_at
        ? (now - new Date(row.price_updated_at).getTime()) / 1000
        : Infinity;
      const chainAge = row.chain_updated_at
        ? (now - new Date(row.chain_updated_at).getTime()) / 1000
        : Infinity;

      if (priceAge > 300) {
        alerts.push({
          severity: 'ERROR',
          symbol: row.symbol,
          type: 'DEAD_PRICE_FEED',
          message: `No price update for ${row.symbol} in ${Math.round(priceAge)}s (failures: ${row.price_fetch_failures})`,
        });
      }
      if (chainAge > 600) {
        alerts.push({
          severity: 'ERROR',
          symbol: row.symbol,
          type: 'DEAD_CHAIN_FEED',
          message: `No chain update for ${row.symbol} in ${Math.round(chainAge)}s (failures: ${row.chain_fetch_failures})`,
        });
      }
    }

    for (const alert of alerts) {
      logger.error(`[DEAD_FEED] ${alert.message}`, 'global-market-state');
    }

    return alerts;
  }

  async _recordFailure(symbol, type, errorMessage) {
    const field = type === 'price' ? 'price' : 'chain';
    await db.query(
      `INSERT INTO global_market_state (symbol, ${field}_fetch_failures, last_${field}_error, updated_at)
       VALUES ($1, 1, $2, NOW())
       ON CONFLICT (symbol) DO UPDATE SET
         ${field}_fetch_failures = global_market_state.${field}_fetch_failures + 1,
         last_${field}_error = $2,
         updated_at = NOW()`,
      [symbol, errorMessage]
    ).catch(() => {});
  }
}

module.exports = new GlobalMarketStateService();
module.exports.GlobalMarketStateService = GlobalMarketStateService;
module.exports.isMarketHours = isMarketHours;
