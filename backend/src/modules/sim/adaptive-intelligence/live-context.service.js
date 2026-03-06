'use strict';

const db = require('../../../config/database');
const dataServiceProxy = require('../../../services/dataServiceProxy');
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
      if (ctx.regime.vix != null) parts.push(`- VIX (spot index): ${ctx.regime.vix}`);
      if (ctx.regime.currentIV != null) {
        const ivPct = (ctx.regime.currentIV * 100).toFixed(1);
        parts.push(`- Current IV: ${ivPct}% (raw=${ctx.regime.currentIV})`);
      }
      if (ctx.regime.hvPercentile != null) parts.push(`- HV Percentile: ${ctx.regime.hvPercentile}`);
      if (ctx.regime.ivRank != null) parts.push(`- IV Rank: ${ctx.regime.ivRank}`);
    }

    if (ctx.gex) {
      parts.push(`- GEX: net=${ctx.gex.netGex || 'N/A'}, flip_price=${ctx.gex.flipPrice || 'N/A'}, environment=${ctx.gex.environment || 'N/A'}`);
    }

    if (ctx.trends && ctx.trends.length > 0) {
      parts.push('- Symbol Trends:');
      for (const t of ctx.trends.slice(0, 10)) {
        parts.push(`  ${t.symbol}: macro=${t.trend || 'N/A'}, local=${t.localBias || 'N/A'}, regime=${t.regime || 'N/A'}, last_price=${t.lastPrice || '-'}, alignment=${t.alignmentScore || '-'}`);
      }
    }

    if (ctx.symbolStates && ctx.symbolStates.length > 0) {
      parts.push('- Active Symbol States:');
      for (const s of ctx.symbolStates.slice(0, 10)) {
        const signals = [];
        if (s.latestDirection) signals.push(`bias=${s.latestDirection}`);
        if (s.latestStrategy) signals.push(`regime=${s.latestStrategy}`);
        if (s.localBias) signals.push(`local=${s.localBias}`);
        if (s.ivPercentile != null) signals.push(`iv_pctl=${s.ivPercentile}`);
        parts.push(`  ${s.symbol}: ${signals.join(', ') || 'idle'}`);
      }
    }

    return parts.join('\n');
  }

  async _getLatestRegime(userId) {
    try {
      const [dbResult, vixData] = await Promise.all([
        db.query(
          `SELECT vs.regime, vs.captured_at,
                  iv.iv_rank, iv.iv_percentile, iv.current_iv
           FROM volatility_snapshots vs
           LEFT JOIN LATERAL (
             SELECT iv_rank, iv_percentile, current_iv
             FROM iv_snapshots
             WHERE symbol = vs.symbol
             ORDER BY captured_at DESC LIMIT 1
           ) iv ON true
           ORDER BY vs.captured_at DESC LIMIT 1`
        ),
        this._fetchVixSpot(),
      ]);

      if (dbResult.rows.length === 0 && !vixData) return null;
      const row = dbResult.rows[0] || {};

      return {
        regime: row.regime || null,
        vix: vixData,
        currentIV: row.current_iv ? parseFloat(row.current_iv) : null,
        hvPercentile: null,
        ivRank: row.iv_rank ? parseFloat(row.iv_rank) : null,
        updatedAt: row.captured_at || null,
      };
    } catch (err) {
      logger.error(`LiveContext: regime fetch failed: ${err.message}`, 'live-context');
      return null;
    }
  }

  async _fetchVixSpot() {
    try {
      const resp = await dataServiceProxy.getVIX();
      const vixData = resp?.data ?? resp;
      let vix = vixData?.spot ?? vixData?.vix ?? null;
      if (vix != null) {
        vix = parseFloat(vix);
        if (vix > 0 && vix < 2.0) {
          vix = vix * 100;
        }
      }
      return vix;
    } catch (err) {
      logger.warn(`LiveContext: VIX API fetch failed, trying db fallback: ${err.message}`, 'live-context');
      try {
        const result = await db.query(
          `SELECT spot FROM vix_snapshots ORDER BY captured_at DESC LIMIT 1`
        );
        if (result.rows.length > 0 && result.rows[0].spot) {
          let vix = parseFloat(result.rows[0].spot);
          if (vix > 0 && vix < 2.0) vix = vix * 100;
          return vix;
        }
      } catch (dbErr) {
        logger.warn(`LiveContext: VIX db fallback also failed: ${dbErr.message}`, 'live-context');
      }
      return null;
    }
  }

  async _getLatestGex() {
    try {
      const result = await db.query(
        `SELECT net_gex, flip_price, total_gex, captured_at
         FROM gex_snapshots
         ORDER BY captured_at DESC LIMIT 1`
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      const netGex = row.net_gex ? parseFloat(row.net_gex) : null;
      let environment = 'UNKNOWN';
      if (netGex != null) {
        if (netGex > 500_000_000) environment = 'STRONG_POSITIVE';
        else if (netGex > 0) environment = 'POSITIVE';
        else if (netGex > -500_000_000) environment = 'NEGATIVE';
        else environment = 'STRONG_NEGATIVE';
      }
      return {
        netGex,
        flipPrice: row.flip_price ? parseFloat(row.flip_price) : null,
        environment,
        updatedAt: row.captured_at,
      };
    } catch (err) {
      logger.error(`LiveContext: GEX fetch failed: ${err.message}`, 'live-context');
      return null;
    }
  }

  async _getLatestTrends(userId, symbols) {
    try {
      let query = `
        SELECT symbol, macro_bias, local_bias, regime,
               last_price, alignment_score, conflict_score, updated_at
        FROM symbol_state
        WHERE user_id = $1 AND macro_bias IS NOT NULL
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
        trend: row.macro_bias,
        localBias: row.local_bias,
        regime: row.regime,
        lastPrice: row.last_price ? parseFloat(row.last_price) : null,
        alignmentScore: row.alignment_score ? parseFloat(row.alignment_score) : null,
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
        SELECT symbol, macro_bias, local_bias, regime,
               alignment_score, conflict_score,
               liquidity_ok, chain_ok, iv_percentile, updated_at
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
        latestDirection: row.macro_bias,
        latestStrategy: row.regime || 'N/A',
        localBias: row.local_bias,
        alignmentScore: row.alignment_score ? parseFloat(row.alignment_score) : null,
        ivPercentile: row.iv_percentile ? parseFloat(row.iv_percentile) : null,
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
