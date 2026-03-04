'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');

const DEFAULT_MAX_AGE = {
  iv: parseInt(process.env.MKT_CTX_IV_MAX_AGE_MS || '1800000', 10),       // 30 min
  gex: parseInt(process.env.MKT_CTX_GEX_MAX_AGE_MS || '600000', 10),      // 10 min
  flow: parseInt(process.env.MKT_CTX_FLOW_MAX_AGE_MS || '900000', 10),     // 15 min
  macro: parseInt(process.env.MKT_CTX_MACRO_MAX_AGE_MS || '14400000', 10), // 4 hours
};

/**
 * Queries the shared Neon Postgres database for the latest IV, GEX,
 * flow, and macro snapshots. Both the data-service and the backend
 * write to and read from the same database, so no proxy call is needed.
 *
 * All queries enforce a configurable max-age threshold — snapshots older
 * than the threshold are treated as stale (returned with `stale: true`
 * so consumers can degrade gracefully).
 *
 * Used by:
 *  - Decision Router: enriches SymbolState before trade evaluation
 *  - Exit Monitor: GEX proximity for dynamic exit params
 *  - Adaptive Intelligence analytics: environment-bucketed performance
 */
class MarketContextService {
  /**
   * Tag a snapshot row with staleness metadata.
   * @returns the row with `stale` and `ageMs` fields added, or null.
   */
  _withStaleness(row, maxAgeMs, label, symbol = null) {
    if (!row || !row.captured_at) return null;
    const ageMs = Date.now() - new Date(row.captured_at).getTime();
    const stale = ageMs > maxAgeMs;
    if (stale) {
      const ageMin = (ageMs / 60000).toFixed(1);
      const maxMin = (maxAgeMs / 60000).toFixed(0);
      logger.warn(
        `[MarketContext] STALE ${label}${symbol ? ` for ${symbol}` : ''}: ${ageMin}min old (max ${maxMin}min)`,
        'market-context'
      );
    }
    return { ...row, stale, ageMs };
  }

  /**
   * Fetch the most recent IV snapshot for a symbol.
   * Returns null if no data is available.
   */
  async getLatestIV(symbol) {
    try {
      const { rows } = await db.query(
        `SELECT current_iv, iv_rank, iv_percentile, hv_30, hv_60, hv_90, captured_at
         FROM iv_snapshots
         WHERE symbol = $1
         ORDER BY captured_at DESC
         LIMIT 1`,
        [symbol.toUpperCase()]
      );
      return this._withStaleness(rows[0], DEFAULT_MAX_AGE.iv, 'IV', symbol);
    } catch (err) {
      logger.error(`[MarketContext] IV fetch failed for ${symbol}: ${err.message}`, 'market-context');
      Sentry.captureException(err, { tags: { module: 'market-context' } });
      return null;
    }
  }

  /**
   * Fetch the most recent GEX snapshot for a symbol.
   */
  async getLatestGEX(symbol) {
    try {
      const { rows } = await db.query(
        `SELECT total_gex, call_gex, put_gex, net_gex, flip_price, major_levels, captured_at
         FROM gex_snapshots
         WHERE symbol = $1
         ORDER BY captured_at DESC
         LIMIT 1`,
        [symbol.toUpperCase()]
      );
      return this._withStaleness(rows[0], DEFAULT_MAX_AGE.gex, 'GEX', symbol);
    } catch (err) {
      logger.error(`[MarketContext] GEX fetch failed for ${symbol}: ${err.message}`, 'market-context');
      Sentry.captureException(err, { tags: { module: 'market-context' } });
      return null;
    }
  }

  /**
   * Fetch the most recent options flow snapshot for a symbol.
   */
  async getLatestFlow(symbol) {
    try {
      const { rows } = await db.query(
        `SELECT total_premium, call_premium, put_premium, net_premium,
                call_volume, put_volume, put_call_ratio, sentiment, captured_at
         FROM options_flow_snapshots
         WHERE symbol = $1
         ORDER BY captured_at DESC
         LIMIT 1`,
        [symbol.toUpperCase()]
      );
      return this._withStaleness(rows[0], DEFAULT_MAX_AGE.flow, 'Flow', symbol);
    } catch (err) {
      logger.error(`[MarketContext] Flow fetch failed for ${symbol}: ${err.message}`, 'market-context');
      Sentry.captureException(err, { tags: { module: 'market-context' } });
      return null;
    }
  }

  /**
   * Fetch the most recent macro snapshot (not symbol-specific).
   */
  async getLatestMacro() {
    try {
      const { rows } = await db.query(
        `SELECT fed_funds_rate, yield_2y, yield_10y, yield_spread, next_fomc, data, captured_at
         FROM macro_snapshots
         ORDER BY captured_at DESC
         LIMIT 1`
      );
      return this._withStaleness(rows[0], DEFAULT_MAX_AGE.macro, 'Macro');
    } catch (err) {
      logger.error(`[MarketContext] Macro fetch failed: ${err.message}`, 'market-context');
      Sentry.captureException(err, { tags: { module: 'market-context' } });
      return null;
    }
  }

  /**
   * Bundle all market context for a symbol in parallel.
   * Non-blocking — returns null for any piece that fails.
   * Each piece is tagged with `stale` and `ageMs` metadata.
   */
  async getFullContext(symbol) {
    const [iv, gex, flow, macro] = await Promise.all([
      this.getLatestIV(symbol),
      this.getLatestGEX(symbol),
      this.getLatestFlow(symbol),
      this.getLatestMacro(),
    ]);

    const hasData = !!(iv || gex || flow || macro);
    const staleCount = [iv, gex, flow, macro].filter(d => d?.stale).length;

    if (hasData) {
      logger.info(
        `[MarketContext] ${symbol}: IV=${iv ? `rank=${iv.iv_rank?.toFixed(0)}${iv.stale ? '(STALE)' : ''}` : 'N/A'} ` +
        `GEX=${gex ? `net=${gex.net_gex?.toFixed(0)} flip=${gex.flip_price}${gex.stale ? '(STALE)' : ''}` : 'N/A'} ` +
        `Flow=${flow ? `sentiment=${flow.sentiment} pcr=${flow.put_call_ratio?.toFixed(2)}${flow.stale ? '(STALE)' : ''}` : 'N/A'} ` +
        `Macro=${macro ? `spread=${macro.yield_spread}${macro.stale ? '(STALE)' : ''}` : 'N/A'}`,
        'market-context'
      );
    }

    return { iv, gex, flow, macro, hasData, staleCount };
  }

  /**
   * Classify IV environment for analytics bucketing.
   */
  classifyIVEnvironment(ivSnapshot) {
    if (!ivSnapshot) return 'UNKNOWN';
    const rank = ivSnapshot.iv_rank;
    if (rank == null) return 'UNKNOWN';
    if (rank >= 80) return 'HIGH_IV';
    if (rank >= 50) return 'MID_IV';
    if (rank >= 20) return 'LOW_IV';
    return 'VERY_LOW_IV';
  }

  /**
   * Classify GEX environment.
   * Positive net GEX = dealer hedging pins price (mean-reverting).
   * Negative net GEX = dealers amplify moves (trending/explosive).
   */
  classifyGEXEnvironment(gexSnapshot) {
    if (!gexSnapshot) return 'UNKNOWN';
    const net = gexSnapshot.net_gex;
    if (net == null) return 'UNKNOWN';
    if (net > 500_000_000) return 'STRONG_POSITIVE';
    if (net > 0) return 'POSITIVE';
    if (net > -500_000_000) return 'NEGATIVE';
    return 'STRONG_NEGATIVE';
  }
}

module.exports = new MarketContextService();
