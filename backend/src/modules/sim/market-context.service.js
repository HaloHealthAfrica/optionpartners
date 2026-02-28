'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');

/**
 * Queries the shared Neon Postgres database for the latest IV, GEX,
 * flow, and macro snapshots. Both the data-service and the backend
 * write to and read from the same database, so no proxy call is needed.
 *
 * Used by:
 *  - Decision Router: enriches SymbolState before trade evaluation
 *  - Exit Monitor: GEX proximity for dynamic exit params
 *  - Adaptive Intelligence analytics: environment-bucketed performance
 */
class MarketContextService {
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
      return rows[0] || null;
    } catch (err) {
      logger.error(`[MarketContext] IV fetch failed for ${symbol}: ${err.message}`, 'market-context');
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
      return rows[0] || null;
    } catch (err) {
      logger.error(`[MarketContext] GEX fetch failed for ${symbol}: ${err.message}`, 'market-context');
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
      return rows[0] || null;
    } catch (err) {
      logger.error(`[MarketContext] Flow fetch failed for ${symbol}: ${err.message}`, 'market-context');
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
      return rows[0] || null;
    } catch (err) {
      logger.error(`[MarketContext] Macro fetch failed: ${err.message}`, 'market-context');
      return null;
    }
  }

  /**
   * Bundle all market context for a symbol in parallel.
   * Non-blocking — returns null for any piece that fails.
   */
  async getFullContext(symbol) {
    const [iv, gex, flow] = await Promise.all([
      this.getLatestIV(symbol),
      this.getLatestGEX(symbol),
      this.getLatestFlow(symbol),
    ]);

    const hasData = !!(iv || gex || flow);

    if (hasData) {
      logger.info(
        `[MarketContext] ${symbol}: IV=${iv ? `rank=${iv.iv_rank?.toFixed(0)}` : 'N/A'} ` +
        `GEX=${gex ? `net=${gex.net_gex?.toFixed(0)} flip=${gex.flip_price}` : 'N/A'} ` +
        `Flow=${flow ? `sentiment=${flow.sentiment} pcr=${flow.put_call_ratio?.toFixed(2)}` : 'N/A'}`,
        'market-context'
      );
    }

    return { iv, gex, flow, hasData };
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
