'use strict';

const db = require('../../../config/database');
const logger = require('../../../utils/logger');

const REGIMES = ['HIGH_VOL_EXPANSION', 'LOW_VOL_CHOP', 'TRENDING', 'NEUTRAL'];

class RegimeEdgeService {
  /**
   * Compute strategy performance segmented by volatility regime.
   * Joins sim_trades with volatility_snapshots to find the regime that was
   * active at each trade's entry time.
   */
  async analyze(userId, options = {}) {
    const lookbackDays = options.lookbackDays || 90;
    const minSampleSize = options.minSampleSize || 5;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lookbackDays);

    // Use regime_at_entry from the trade itself (populated at finalization),
    // falling back to a lateral join against volatility_snapshots for legacy trades.
    const { rows } = await db.query(
      `SELECT
         st.strategy,
         st.symbol,
         st.pnl,
         st.pnl_percent,
         st.r_multiple,
         st.entry_time,
         st.exit_time,
         st.dte_at_entry,
         st.delta_at_entry,
         st.regime_at_entry,
         st.regime_source,
         vs.regime as vs_regime,
         vs.captured_at as regime_at
       FROM sim_trades st
       LEFT JOIN LATERAL (
         SELECT regime, captured_at
         FROM volatility_snapshots
         WHERE symbol = st.underlying_symbol
           AND captured_at <= st.entry_time
         ORDER BY captured_at DESC
         LIMIT 1
       ) vs ON true
       WHERE st.user_id = $1
         AND st.exit_time IS NOT NULL
         AND st.entry_time >= $2
       ORDER BY st.entry_time DESC`,
      [userId, cutoff]
    );

    if (rows.length === 0) {
      return { matrix: [], strategies: [], regimes: REGIMES, totalTrades: 0, lookbackDays };
    }

    const tradesWithRegime = rows.map(row => ({
      ...row,
      regime: row.regime_at_entry || row.vs_regime || 'UNKNOWN',
    }));

    // Build strategy × regime matrix
    const matrixMap = new Map();

    for (const trade of tradesWithRegime) {
      const key = `${trade.strategy}::${trade.regime}`;
      if (!matrixMap.has(key)) {
        matrixMap.set(key, {
          strategy: trade.strategy,
          regime: trade.regime,
          trades: [],
        });
      }
      matrixMap.get(key).trades.push(trade);
    }

    const matrix = [];
    for (const [, cell] of matrixMap) {
      const metrics = this._computeMetrics(cell.trades);
      const status = this._determineStatus(metrics, minSampleSize);

      matrix.push({
        strategy: cell.strategy,
        regime: cell.regime,
        ...metrics,
        status,
      });
    }

    // Sort: strategy asc, then regime
    matrix.sort((a, b) => {
      const s = a.strategy.localeCompare(b.strategy);
      return s !== 0 ? s : a.regime.localeCompare(b.regime);
    });

    const strategies = [...new Set(matrix.map(m => m.strategy))];
    const regimesFound = [...new Set(matrix.map(m => m.regime))];

    // Compute current regime implications (if we have a current regime)
    const currentImplications = this._computeImplications(matrix, minSampleSize);

    const unknownCount = tradesWithRegime.filter(t => t.regime === 'UNKNOWN').length;
    const unknownRate = tradesWithRegime.length > 0
      ? Math.round((unknownCount / tradesWithRegime.length) * 10000) / 100
      : 0;

    const regimeHealth = {
      unknownCount,
      unknownRate,
      status: unknownRate > 50
        ? 'REGIME_DATA_UNRELIABLE'
        : unknownRate > 30
          ? 'REGIME_DATA_DEGRADED'
          : 'HEALTHY',
      warning: unknownRate > 50
        ? `${unknownRate}% of trades have UNKNOWN regime — regime-dependent logic is effectively non-functional. Likely cause: missing volatility_snapshots or VIX data feed issue.`
        : null,
    };

    if (unknownRate > 50) {
      logger.warn(
        `[REGIME_HEALTH] ${unknownRate}% UNKNOWN regime rate (${unknownCount}/${tradesWithRegime.length} trades) — regime engine may be non-functional`,
        'regime-edge'
      );
    }

    return {
      matrix,
      strategies,
      regimes: regimesFound,
      totalTrades: tradesWithRegime.length,
      lookbackDays,
      currentImplications,
      regimeHealth,
      computedAt: Date.now(),
    };
  }

  /**
   * Get the current regime for a symbol from the latest volatility snapshot.
   */
  async getCurrentRegime(symbol) {
    const { rows } = await db.query(
      `SELECT regime, metrics, captured_at
       FROM volatility_snapshots
       WHERE symbol = $1
       ORDER BY captured_at DESC
       LIMIT 1`,
      [symbol]
    );
    return rows[0] || null;
  }

  _computeMetrics(trades) {
    const pnls = trades.map(t => parseFloat(t.pnl));
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p <= 0);

    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const winRate = trades.length > 0 ? wins.length / trades.length : 0;
    const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;

    const rValues = trades.filter(t => t.r_multiple != null).map(t => parseFloat(t.r_multiple));
    const avgR = rValues.length > 0 ? rValues.reduce((a, b) => a + b, 0) / rValues.length : 0;

    const grossWins = wins.reduce((a, b) => a + b, 0);
    const grossLosses = Math.abs(losses.reduce((a, b) => a + b, 0));
    // Fix 8: Use null instead of 999 sentinel — prevents corruption of downstream PF aggregation
    const profitFactorRaw = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? null : 0);
    const profitFactor = profitFactorRaw != null ? Math.round(profitFactorRaw * 100) / 100 : null;
    const profitFactorIsSentinel = profitFactorRaw === null && grossWins > 0;

    return {
      totalTrades: trades.length,
      winRate: Math.round(winRate * 10000) / 10000,
      avgPnl: Math.round(avgPnl * 100) / 100,
      avgR: Math.round(avgR * 1000) / 1000,
      totalPnl: Math.round(totalPnl * 100) / 100,
      profitFactor,
      profitFactorIsSentinel,
    };
  }

  _determineStatus(metrics, minSampleSize) {
    if (metrics.totalTrades < minSampleSize) return 'INSUFFICIENT_DATA';
    // profitFactor null = infinite (no losses); treat as STRONG for status
    const pfOk = metrics.profitFactor == null || metrics.profitFactor >= 1.0;
    const pfStrong = metrics.profitFactor == null || metrics.profitFactor >= 1.5;
    if (metrics.winRate < 0.40 || !pfOk) return 'SUPPRESSED';
    if (metrics.winRate >= 0.60 && pfStrong) return 'STRONG';
    return 'ACTIVE';
  }

  /**
   * For each strategy, identify which regimes are strong/suppressed.
   */
  _computeImplications(matrix, minSampleSize) {
    const byStrategy = new Map();
    for (const cell of matrix) {
      if (!byStrategy.has(cell.strategy)) {
        byStrategy.set(cell.strategy, []);
      }
      byStrategy.get(cell.strategy).push(cell);
    }

    const implications = [];
    for (const [strategy, cells] of byStrategy) {
      const strong = cells.filter(c => c.status === 'STRONG').map(c => c.regime);
      const suppressed = cells.filter(c => c.status === 'SUPPRESSED').map(c => c.regime);
      const active = cells.filter(c => c.status === 'ACTIVE').map(c => c.regime);

      implications.push({ strategy, strong, active, suppressed });
    }

    return implications;
  }
}

module.exports = new RegimeEdgeService();
