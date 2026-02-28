'use strict';

const db = require('../../../config/database');
const logger = require('../../../utils/logger');

class SignalQualityService {
  /**
   * Comprehensive signal quality analysis:
   *  1. Source performance — win rate, avg PnL, profit factor by indicator source
   *  2. Conviction accuracy — do higher conviction scores actually produce better outcomes?
   *  3. Delta/DTE selection — which delta and DTE buckets perform best?
   *  4. Position sizing — is the conviction-to-size mapping optimal?
   *  5. Expected move filter — is the filter blocking winners or protecting from losers?
   */
  async analyze(userId, options = {}) {
    const lookbackDays = options.lookbackDays || 90;
    const minSampleSize = options.minSampleSize || 5;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lookbackDays);

    const [sourcePerf, convictionAccuracy, deltaPerf, dtePerf, sizingPerf, expectedMovePerf] =
      await Promise.all([
        this._sourcePerformance(userId, cutoff, minSampleSize),
        this._convictionAccuracy(userId, cutoff),
        this._deltaPerformance(userId, cutoff, minSampleSize),
        this._dtePerformance(userId, cutoff, minSampleSize),
        this._sizingPerformance(userId, cutoff),
        this._expectedMoveAnalysis(userId, cutoff, minSampleSize),
      ]);

    const totalTrades = sourcePerf.reduce((sum, s) => sum + s.sampleSize, 0);

    return {
      sourcePerformance: sourcePerf,
      convictionAccuracy,
      deltaPerformance: deltaPerf,
      dtePerformance: dtePerf,
      sizingPerformance: sizingPerf,
      expectedMoveFilter: expectedMovePerf,
      totalTrades,
      lookbackDays,
      computedAt: Date.now(),
    };
  }

  /**
   * Win rate, profit factor, avg PnL by indicator source (strategy column).
   */
  async _sourcePerformance(userId, cutoff, minSampleSize) {
    const { rows } = await db.query(
      `SELECT
         st.strategy as source,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE st.pnl > 0) as wins,
         COUNT(*) FILTER (WHERE st.pnl <= 0) as losses,
         ROUND(AVG(st.pnl)::numeric, 2) as avg_pnl,
         ROUND(SUM(st.pnl)::numeric, 2) as total_pnl,
         ROUND(AVG(st.pnl_percent)::numeric, 2) as avg_pnl_pct,
         ROUND(AVG(CASE WHEN st.r_multiple IS NOT NULL THEN st.r_multiple END)::numeric, 3) as avg_r,
         ROUND(COALESCE(SUM(st.pnl) FILTER (WHERE st.pnl > 0), 0)::numeric, 2) as gross_wins,
         ROUND(ABS(COALESCE(SUM(st.pnl) FILTER (WHERE st.pnl <= 0), 0))::numeric, 2) as gross_losses,
         ROUND(AVG(iv.intelligence_score)::numeric, 1) as avg_conviction
       FROM sim_trades st
       LEFT JOIN intelligence_verdicts iv ON iv.webhook_event_id = st.webhook_event_id
       WHERE st.user_id = $1
         AND st.exit_time IS NOT NULL
         AND st.entry_time >= $2
       GROUP BY st.strategy
       ORDER BY COUNT(*) DESC`,
      [userId, cutoff]
    );

    return rows.map(r => ({
      source: r.source || 'UNKNOWN',
      sampleSize: parseInt(r.total),
      wins: parseInt(r.wins),
      losses: parseInt(r.losses),
      winRate: parseInt(r.total) > 0 ? parseInt(r.wins) / parseInt(r.total) : 0,
      avgPnl: parseFloat(r.avg_pnl) || 0,
      totalPnl: parseFloat(r.total_pnl) || 0,
      avgPnlPct: parseFloat(r.avg_pnl_pct) || 0,
      avgR: parseFloat(r.avg_r) || 0,
      profitFactor: parseFloat(r.gross_losses) > 0
        ? Math.round((parseFloat(r.gross_wins) / parseFloat(r.gross_losses)) * 100) / 100
        : parseFloat(r.gross_wins) > 0 ? 999 : 0,
      avgConviction: parseFloat(r.avg_conviction) || 0,
      significant: parseInt(r.total) >= minSampleSize,
    }));
  }

  /**
   * Conviction score bucketed by outcome: are higher scores really better?
   */
  async _convictionAccuracy(userId, cutoff) {
    const { rows } = await db.query(
      `SELECT
         CASE
           WHEN iv.intelligence_score >= 90 THEN '90+'
           WHEN iv.intelligence_score >= 80 THEN '80-89'
           WHEN iv.intelligence_score >= 70 THEN '70-79'
           WHEN iv.intelligence_score >= 60 THEN '60-69'
           WHEN iv.intelligence_score >= 50 THEN '50-59'
           ELSE '<50'
         END as bucket,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE st.pnl > 0) as wins,
         ROUND(AVG(st.pnl)::numeric, 2) as avg_pnl,
         ROUND(AVG(st.pnl_percent)::numeric, 2) as avg_pnl_pct,
         ROUND(AVG(st.r_multiple)::numeric, 3) as avg_r,
         ROUND(SUM(st.pnl)::numeric, 2) as total_pnl
       FROM intelligence_verdicts iv
       INNER JOIN sim_trades st ON st.webhook_event_id = iv.webhook_event_id
       WHERE iv.user_id = $1
         AND iv.allowed = true
         AND st.exit_time IS NOT NULL
         AND iv.created_at >= $2
       GROUP BY 1
       ORDER BY 1 DESC`,
      [userId, cutoff]
    );

    const buckets = rows.map(r => ({
      bucket: r.bucket,
      sampleSize: parseInt(r.total),
      wins: parseInt(r.wins),
      winRate: parseInt(r.total) > 0 ? parseInt(r.wins) / parseInt(r.total) : 0,
      avgPnl: parseFloat(r.avg_pnl) || 0,
      avgPnlPct: parseFloat(r.avg_pnl_pct) || 0,
      avgR: parseFloat(r.avg_r) || 0,
      totalPnl: parseFloat(r.total_pnl) || 0,
    }));

    const isMonotonic = this._checkMonotonicity(buckets);

    return {
      buckets,
      isMonotonic,
      recommendation: isMonotonic
        ? 'Conviction scoring is well-calibrated — higher scores correlate with better outcomes'
        : 'Conviction scoring may need adjustment — higher scores do not consistently outperform',
    };
  }

  /**
   * Performance bucketed by delta_at_entry.
   */
  async _deltaPerformance(userId, cutoff, minSampleSize) {
    const { rows } = await db.query(
      `SELECT
         CASE
           WHEN ABS(delta_at_entry) >= 0.70 THEN 'Deep ITM (0.70+)'
           WHEN ABS(delta_at_entry) >= 0.60 THEN 'ITM (0.60-0.69)'
           WHEN ABS(delta_at_entry) >= 0.50 THEN 'ATM (0.50-0.59)'
           WHEN ABS(delta_at_entry) >= 0.40 THEN 'Slight OTM (0.40-0.49)'
           WHEN ABS(delta_at_entry) >= 0.30 THEN 'OTM (0.30-0.39)'
           ELSE 'Deep OTM (<0.30)'
         END as bucket,
         ROUND(AVG(ABS(delta_at_entry))::numeric, 3) as avg_delta,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE pnl > 0) as wins,
         ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
         ROUND(AVG(pnl_percent)::numeric, 2) as avg_pnl_pct,
         ROUND(AVG(r_multiple)::numeric, 3) as avg_r,
         ROUND(SUM(pnl)::numeric, 2) as total_pnl
       FROM sim_trades
       WHERE user_id = $1
         AND exit_time IS NOT NULL
         AND entry_time >= $2
         AND delta_at_entry IS NOT NULL
       GROUP BY 1
       ORDER BY avg_delta DESC`,
      [userId, cutoff]
    );

    const buckets = rows.map(r => ({
      bucket: r.bucket,
      avgDelta: parseFloat(r.avg_delta),
      sampleSize: parseInt(r.total),
      wins: parseInt(r.wins),
      winRate: parseInt(r.total) > 0 ? parseInt(r.wins) / parseInt(r.total) : 0,
      avgPnl: parseFloat(r.avg_pnl) || 0,
      avgPnlPct: parseFloat(r.avg_pnl_pct) || 0,
      avgR: parseFloat(r.avg_r) || 0,
      totalPnl: parseFloat(r.total_pnl) || 0,
      significant: parseInt(r.total) >= minSampleSize,
    }));

    const best = buckets.filter(b => b.significant).sort((a, b) => b.winRate - a.winRate)[0];

    return {
      buckets,
      optimalDeltaRange: best ? best.bucket : null,
      recommendation: best
        ? `Best delta range: ${best.bucket} (${(best.winRate * 100).toFixed(1)}% WR, n=${best.sampleSize})`
        : 'Insufficient delta data for recommendation',
    };
  }

  /**
   * Performance bucketed by dte_at_entry.
   */
  async _dtePerformance(userId, cutoff, minSampleSize) {
    const { rows } = await db.query(
      `SELECT
         CASE
           WHEN dte_at_entry = 0 THEN '0DTE'
           WHEN dte_at_entry BETWEEN 1 AND 3 THEN '1-3 DTE'
           WHEN dte_at_entry BETWEEN 4 AND 7 THEN '4-7 DTE'
           WHEN dte_at_entry BETWEEN 8 AND 14 THEN '8-14 DTE'
           WHEN dte_at_entry BETWEEN 15 AND 30 THEN '15-30 DTE'
           WHEN dte_at_entry BETWEEN 31 AND 45 THEN '31-45 DTE'
           ELSE '45+ DTE'
         END as bucket,
         ROUND(AVG(dte_at_entry)::numeric, 1) as avg_dte,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE pnl > 0) as wins,
         ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
         ROUND(AVG(pnl_percent)::numeric, 2) as avg_pnl_pct,
         ROUND(AVG(r_multiple)::numeric, 3) as avg_r,
         ROUND(SUM(pnl)::numeric, 2) as total_pnl
       FROM sim_trades
       WHERE user_id = $1
         AND exit_time IS NOT NULL
         AND entry_time >= $2
         AND dte_at_entry IS NOT NULL
       GROUP BY 1
       ORDER BY avg_dte ASC`,
      [userId, cutoff]
    );

    const buckets = rows.map(r => ({
      bucket: r.bucket,
      avgDte: parseFloat(r.avg_dte),
      sampleSize: parseInt(r.total),
      wins: parseInt(r.wins),
      winRate: parseInt(r.total) > 0 ? parseInt(r.wins) / parseInt(r.total) : 0,
      avgPnl: parseFloat(r.avg_pnl) || 0,
      avgPnlPct: parseFloat(r.avg_pnl_pct) || 0,
      avgR: parseFloat(r.avg_r) || 0,
      totalPnl: parseFloat(r.total_pnl) || 0,
      significant: parseInt(r.total) >= minSampleSize,
    }));

    const best = buckets.filter(b => b.significant).sort((a, b) => b.avgR - a.avgR)[0];

    return {
      buckets,
      optimalDteRange: best ? best.bucket : null,
      recommendation: best
        ? `Best DTE range: ${best.bucket} (avg R: ${best.avgR}, ${(best.winRate * 100).toFixed(1)}% WR, n=${best.sampleSize})`
        : 'Insufficient DTE data for recommendation',
    };
  }

  /**
   * Position sizing analysis: performance by size_multiplier tier.
   */
  async _sizingPerformance(userId, cutoff) {
    const { rows } = await db.query(
      `SELECT
         CASE
           WHEN iv.checks_detail->>'size_multiplier' IS NOT NULL THEN
             CASE
               WHEN (iv.checks_detail->>'size_multiplier')::numeric >= 1.5 THEN '1.5x (high conviction)'
               WHEN (iv.checks_detail->>'size_multiplier')::numeric >= 1.25 THEN '1.25x (elevated)'
               ELSE '1.0x (standard)'
             END
           ELSE '1.0x (standard)'
         END as size_tier,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE st.pnl > 0) as wins,
         ROUND(AVG(st.pnl)::numeric, 2) as avg_pnl,
         ROUND(AVG(st.pnl_percent)::numeric, 2) as avg_pnl_pct,
         ROUND(AVG(st.r_multiple)::numeric, 3) as avg_r,
         ROUND(SUM(st.pnl)::numeric, 2) as total_pnl,
         ROUND(AVG(iv.intelligence_score)::numeric, 1) as avg_conviction
       FROM intelligence_verdicts iv
       INNER JOIN sim_trades st ON st.webhook_event_id = iv.webhook_event_id
       WHERE iv.user_id = $1
         AND iv.allowed = true
         AND st.exit_time IS NOT NULL
         AND iv.created_at >= $2
       GROUP BY 1
       ORDER BY avg_conviction DESC`,
      [userId, cutoff]
    );

    const tiers = rows.map(r => ({
      tier: r.size_tier,
      sampleSize: parseInt(r.total),
      wins: parseInt(r.wins),
      winRate: parseInt(r.total) > 0 ? parseInt(r.wins) / parseInt(r.total) : 0,
      avgPnl: parseFloat(r.avg_pnl) || 0,
      avgPnlPct: parseFloat(r.avg_pnl_pct) || 0,
      avgR: parseFloat(r.avg_r) || 0,
      totalPnl: parseFloat(r.total_pnl) || 0,
      avgConviction: parseFloat(r.avg_conviction) || 0,
    }));

    const highConv = tiers.find(t => t.tier.includes('1.5x'));
    const standard = tiers.find(t => t.tier.includes('1.0x'));
    const sizingEffective = highConv && standard && highConv.winRate > standard.winRate;

    return {
      tiers,
      sizingEffective,
      recommendation: sizingEffective
        ? 'Position sizing is working — larger sizes on high conviction outperform standard'
        : highConv && standard
          ? 'High-conviction sizing underperforms standard — consider flattening the curve'
          : 'Insufficient data across sizing tiers',
    };
  }

  /**
   * Expected move filter analysis: what it blocked vs what passed.
   */
  async _expectedMoveAnalysis(userId, cutoff, minSampleSize) {
    const [rejections, passedTrades] = await Promise.all([
      db.query(
        `SELECT COUNT(*) as total,
                COUNT(DISTINCT symbol) as symbols
         FROM signal_rejections
         WHERE user_id = $1
           AND gate = 'EXPECTED_MOVE'
           AND created_at >= $2`,
        [userId, cutoff]
      ),
      db.query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE pnl > 0) as wins,
           ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
           ROUND(AVG(pnl_percent)::numeric, 2) as avg_pnl_pct
         FROM sim_trades
         WHERE user_id = $1
           AND exit_time IS NOT NULL
           AND entry_time >= $2`,
        [userId, cutoff]
      ),
    ]);

    const rejCount = parseInt(rejections.rows[0]?.total || 0);
    const rejSymbols = parseInt(rejections.rows[0]?.symbols || 0);
    const passedCount = parseInt(passedTrades.rows[0]?.total || 0);
    const passedWins = parseInt(passedTrades.rows[0]?.wins || 0);
    const passedWinRate = passedCount > 0 ? passedWins / passedCount : 0;

    const totalSignals = rejCount + passedCount;
    const filterRate = totalSignals > 0 ? rejCount / totalSignals : 0;

    return {
      rejected: rejCount,
      rejectedSymbols: rejSymbols,
      passed: passedCount,
      passedWinRate,
      filterRate,
      recommendation: filterRate > 0.3
        ? `Expected move filter is blocking ${(filterRate * 100).toFixed(0)}% of signals — may be too aggressive`
        : filterRate > 0
          ? `Filter blocking ${(filterRate * 100).toFixed(0)}% — appears well-calibrated`
          : 'Expected move filter has not blocked any signals in this window',
    };
  }

  _checkMonotonicity(buckets) {
    if (buckets.length < 2) return true;
    const sorted = buckets.filter(b => b.sampleSize >= 3).sort((a, b) => {
      const order = { '90+': 6, '80-89': 5, '70-79': 4, '60-69': 3, '50-59': 2, '<50': 1 };
      return (order[b.bucket] || 0) - (order[a.bucket] || 0);
    });
    if (sorted.length < 2) return true;
    let monotonic = true;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].winRate > sorted[i - 1].winRate + 0.05) {
        monotonic = false;
        break;
      }
    }
    return monotonic;
  }
}

module.exports = new SignalQualityService();
