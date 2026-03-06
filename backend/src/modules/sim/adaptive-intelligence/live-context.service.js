'use strict';

const db = require('../../../config/database');
const logger = require('../../../utils/logger');

/**
 * LiveContextService — Assembles real-time market context for AI prompts.
 *
 * Pulls current VIX/regime, GEX snapshot, trend state, and IV rank from
 * existing tables. Used to enrich AI prompts with live conditions rather
 * than just historical stats.
 */
class LiveContextService {
  /**
   * Build a live market context block for inclusion in AI prompts.
   * @param {string} userId
   * @param {string[]} [symbols] - Optional symbol filter
   * @returns {Promise<Object>} Live context data
   */
  async buildContext(userId, symbols = []) {
    const [regime, gex, trends, symbolStates] = await Promise.all([
      this._getLatestRegime(userId),
      this._getLatestGex(),
      this._getLatestTrends(userId, symbols),
      this._getSymbolStates(userId, symbols),
    ]);

    return {
      timestamp: new Date().toISOString(),
      regime,
      gex,
      trends,
      symbolStates,
      sessionPhase: this._deriveSessionPhase(),
    };
  }

  /**
   * Format live context as a text block for AI prompt injection.
   */
  async buildContextBlock(userId, symbols = []) {
    const ctx = await this.buildContext(userId, symbols);

    const parts = ['LIVE MARKET CONTEXT (current conditions):'];

    if (ctx.sessionPhase) {
      parts.push(`- Session Phase: ${ctx.sessionPhase}`);
    }

    if (ctx.regime) {
      parts.push(`- Volatility Regime: ${ctx.regime.regime || 'UNKNOWN'}`);
      if (ctx.regime.vix != null) parts.push(`- VIX: ${ctx.regime.vix}`);
      if (ctx.regime.hvPercentile != null) parts.push(`- HV Percentile: ${ctx.regime.hvPercentile}`);
      if (ctx.regime.ivRank != null) parts.push(`- IV Rank: ${ctx.regime.ivRank}`);
    }

    if (ctx.gex) {
      parts.push(`- GEX: net=${ctx.gex.netGex || 'N/A'}, flip_price=${ctx.gex.flipPrice || 'N/A'}, environment=${ctx.gex.environment || 'N/A'}`);
    }

    if (ctx.trends && ctx.trends.length > 0) {
      parts.push('- Symbol Trends:');
      for (const t of ctx.trends.slice(0, 10)) {
        parts.push(`  ${t.symbol}: trend=${t.trend || 'N/A'}, ema9=${t.emaFast || '-'}, ema21=${t.emaSlow || '-'}, last_price=${t.lastPrice || '-'}`);
      }
    }

    if (ctx.symbolStates && ctx.symbolStates.length > 0) {
      parts.push('- Active Symbol States:');
      for (const s of ctx.symbolStates.slice(0, 10)) {
        const signals = [];
        if (s.latestDirection) signals.push(`dir=${s.latestDirection}`);
        if (s.latestStrategy) signals.push(`strat=${s.latestStrategy}`);
        if (s.signalCount) signals.push(`signals=${s.signalCount}`);
        parts.push(`  ${s.symbol}: ${signals.join(', ') || 'idle'}`);
      }
    }

    return parts.join('\n');
  }

  async _getLatestRegime(userId) {
    try {
      const result = await db.query(
        `SELECT regime, vix, hv_percentile, iv_rank, created_at
         FROM volatility_snapshots
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        regime: row.regime,
        vix: row.vix ? parseFloat(row.vix) : null,
        hvPercentile: row.hv_percentile ? parseFloat(row.hv_percentile) : null,
        ivRank: row.iv_rank ? parseFloat(row.iv_rank) : null,
        updatedAt: row.created_at,
      };
    } catch (err) {
      logger.error(`LiveContext: regime fetch failed: ${err.message}`, 'live-context');
      return null;
    }
  }

  async _getLatestGex() {
    try {
      const result = await db.query(
        `SELECT net_gex, flip_price, gex_environment, created_at
         FROM gex_snapshots
         ORDER BY created_at DESC LIMIT 1`
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        netGex: row.net_gex ? parseFloat(row.net_gex) : null,
        flipPrice: row.flip_price ? parseFloat(row.flip_price) : null,
        environment: row.gex_environment,
        updatedAt: row.created_at,
      };
    } catch (err) {
      logger.error(`LiveContext: GEX fetch failed: ${err.message}`, 'live-context');
      return null;
    }
  }

  async _getLatestTrends(userId, symbols) {
    try {
      let query = `
        SELECT symbol, trend_direction as trend,
               ema_fast, ema_slow, last_price, updated_at
        FROM symbol_state
        WHERE user_id = $1 AND trend_direction IS NOT NULL
      `;
      const params = [userId];

      if (symbols.length > 0) {
        query += ` AND symbol = ANY($2)`;
        params.push(symbols);
      }

      query += ` ORDER BY updated_at DESC LIMIT 20`;

      const result = await db.query(query, params);
      return result.rows.map(row => ({
        symbol: row.symbol,
        trend: row.trend,
        emaFast: row.ema_fast ? parseFloat(row.ema_fast) : null,
        emaSlow: row.ema_slow ? parseFloat(row.ema_slow) : null,
        lastPrice: row.last_price ? parseFloat(row.last_price) : null,
        updatedAt: row.updated_at,
      }));
    } catch (err) {
      logger.error(`LiveContext: trends fetch failed: ${err.message}`, 'live-context');
      return [];
    }
  }

  async _getSymbolStates(userId, symbols) {
    try {
      let query = `
        SELECT symbol, latest_direction, latest_strategy,
               signal_count, updated_at
        FROM symbol_state
        WHERE user_id = $1
      `;
      const params = [userId];

      if (symbols.length > 0) {
        query += ` AND symbol = ANY($2)`;
        params.push(symbols);
      }

      query += ` ORDER BY updated_at DESC LIMIT 20`;

      const result = await db.query(query, params);
      return result.rows.map(row => ({
        symbol: row.symbol,
        latestDirection: row.latest_direction,
        latestStrategy: row.latest_strategy,
        signalCount: row.signal_count,
        updatedAt: row.updated_at,
      }));
    } catch (err) {
      logger.error(`LiveContext: symbol states fetch failed: ${err.message}`, 'live-context');
      return [];
    }
  }

  _deriveSessionPhase() {
    const now = new Date();
    const etOffset = this._getETOffset();
    const etHour = (now.getUTCHours() + etOffset + 24) % 24;
    const etMin = now.getUTCMinutes();
    const totalMin = etHour * 60 + etMin;

    if (totalMin < 570) return 'PRE_MARKET';        // Before 9:30
    if (totalMin < 600) return 'OPEN_AUCTION';       // 9:30–10:00
    if (totalMin < 720) return 'MORNING';            // 10:00–12:00
    if (totalMin < 840) return 'MIDDAY';             // 12:00–14:00
    if (totalMin < 930) return 'AFTERNOON';           // 14:00–15:30
    if (totalMin < 960) return 'CLOSE_AUCTION';      // 15:30–16:00
    return 'AFTER_HOURS';
  }

  _getETOffset() {
    const jan = new Date(new Date().getFullYear(), 0, 1);
    const jul = new Date(new Date().getFullYear(), 6, 1);
    const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
    const isDST = new Date().getTimezoneOffset() < stdOffset;
    return isDST ? -4 : -5;
  }
}

module.exports = new LiveContextService();
