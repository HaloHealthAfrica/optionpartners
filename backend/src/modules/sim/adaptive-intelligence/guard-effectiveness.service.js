'use strict';

const db = require('../../../config/database');
const logger = require('../../../utils/logger');

class GuardEffectivenessService {
  /**
   * Comprehensive guard effectiveness analysis:
   *  1. Gate rejection breakdown — how often each gate fires
   *  2. Guard precision — of blocked signals, % that would have lost
   *  3. Exit quality — MAE/MFE analysis for stop/target calibration
   *  4. Exit reason breakdown — which exit types produce best outcomes
   *  5. Processing latency — webhook timing analysis
   */
  async analyze(userId, options = {}) {
    const lookbackDays = options.lookbackDays || 90;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lookbackDays);

    const [gateBreakdown, exitQuality, exitReasons, latency, guardThresholds] =
      await Promise.all([
        this._gateRejectionBreakdown(userId, cutoff),
        this._exitQualityAnalysis(userId, cutoff),
        this._exitReasonBreakdown(userId, cutoff),
        this._processingLatency(userId, cutoff),
        this._guardThresholdAnalysis(userId, cutoff),
      ]);

    const totalRejections = gateBreakdown.reduce((sum, g) => sum + g.count, 0);
    const totalTrades = exitQuality.totalTrades;

    return {
      gateBreakdown,
      exitQuality,
      exitReasons,
      latency,
      guardThresholds,
      totalRejections,
      totalTrades,
      acceptanceRate: totalRejections + totalTrades > 0
        ? Math.round((totalTrades / (totalRejections + totalTrades)) * 10000) / 100
        : 0,
      lookbackDays,
      computedAt: Date.now(),
    };
  }

  /**
   * Rejection count and rate by gate type.
   */
  async _gateRejectionBreakdown(userId, cutoff) {
    const { rows } = await db.query(
      `SELECT
         gate,
         COUNT(*) as total,
         COUNT(DISTINCT symbol) as symbols_affected,
         COUNT(DISTINCT strategy) as strategies_affected,
         MIN(created_at) as first_rejection,
         MAX(created_at) as last_rejection
       FROM signal_rejections
       WHERE user_id = $1
         AND created_at >= $2
       GROUP BY gate
       ORDER BY total DESC`,
      [userId, cutoff]
    );

    const totalRejections = rows.reduce((s, r) => s + parseInt(r.total), 0);

    return rows.map(r => ({
      gate: r.gate,
      count: parseInt(r.total),
      percentage: totalRejections > 0
        ? Math.round((parseInt(r.total) / totalRejections) * 10000) / 100
        : 0,
      symbolsAffected: parseInt(r.symbols_affected),
      strategiesAffected: parseInt(r.strategies_affected),
      firstSeen: r.first_rejection,
      lastSeen: r.last_rejection,
    }));
  }

  /**
   * MAE/MFE analysis for exit parameter calibration.
   * Answers: are stops too tight? Are targets too conservative?
   */
  async _exitQualityAnalysis(userId, cutoff) {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE pnl > 0) as wins,
         COUNT(*) FILTER (WHERE pnl <= 0) as losses,

         -- MAE analysis (how far against the trade before exit)
         ROUND(AVG(max_adverse_excursion)::numeric, 4) as avg_mae,
         ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY max_adverse_excursion)::numeric, 4) as mae_p25,
         ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY max_adverse_excursion)::numeric, 4) as mae_median,
         ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY max_adverse_excursion)::numeric, 4) as mae_p75,
         ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY max_adverse_excursion)::numeric, 4) as mae_p90,

         -- MFE analysis (how far in favor before exit)
         ROUND(AVG(max_favorable_excursion)::numeric, 4) as avg_mfe,
         ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY max_favorable_excursion)::numeric, 4) as mfe_p25,
         ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY max_favorable_excursion)::numeric, 4) as mfe_median,
         ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY max_favorable_excursion)::numeric, 4) as mfe_p75,
         ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY max_favorable_excursion)::numeric, 4) as mfe_p90,

         -- Winners MAE: how much heat did winning trades take?
         ROUND(AVG(max_adverse_excursion) FILTER (WHERE pnl > 0)::numeric, 4) as winner_avg_mae,
         ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY max_adverse_excursion) FILTER (WHERE pnl > 0)::numeric, 4) as winner_mae_p90,

         -- Losers MFE: how much profit did losing trades give back?
         ROUND(AVG(max_favorable_excursion) FILTER (WHERE pnl <= 0)::numeric, 4) as loser_avg_mfe,
         ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY max_favorable_excursion) FILTER (WHERE pnl <= 0)::numeric, 4) as loser_mfe_p75

       FROM sim_trades
       WHERE user_id = $1
         AND exit_time IS NOT NULL
         AND entry_time >= $2
         AND max_adverse_excursion IS NOT NULL
         AND max_favorable_excursion IS NOT NULL`,
      [userId, cutoff]
    );

    const r = rows[0] || {};
    const totalTrades = parseInt(r.total) || 0;

    const winnerMaeP90 = parseFloat(r.winner_mae_p90) || 0;
    const loserMfeP75 = parseFloat(r.loser_mfe_p75) || 0;

    const recommendations = [];
    if (winnerMaeP90 > 0 && totalTrades >= 10) {
      recommendations.push({
        type: 'stop_adjustment',
        current: 'Static stop levels',
        suggested: `Set stops wide enough to accommodate ${(winnerMaeP90 * 100).toFixed(1)}% MAE (90th percentile of winners)`,
        rationale: 'Winning trades experienced this much adverse move before recovering',
      });
    }
    if (loserMfeP75 > 0 && totalTrades >= 10) {
      recommendations.push({
        type: 'target_adjustment',
        current: 'Static take-profit levels',
        suggested: `Consider partial profits at ${(loserMfeP75 * 100).toFixed(1)}% MFE (75th percentile of losers)`,
        rationale: 'Losing trades reached this favorable excursion before reversing',
      });
    }

    return {
      totalTrades,
      wins: parseInt(r.wins) || 0,
      losses: parseInt(r.losses) || 0,
      mae: {
        avg: parseFloat(r.avg_mae) || 0,
        p25: parseFloat(r.mae_p25) || 0,
        median: parseFloat(r.mae_median) || 0,
        p75: parseFloat(r.mae_p75) || 0,
        p90: parseFloat(r.mae_p90) || 0,
      },
      mfe: {
        avg: parseFloat(r.avg_mfe) || 0,
        p25: parseFloat(r.mfe_p25) || 0,
        median: parseFloat(r.mfe_median) || 0,
        p75: parseFloat(r.mfe_p75) || 0,
        p90: parseFloat(r.mfe_p90) || 0,
      },
      winnerMae: {
        avg: parseFloat(r.winner_avg_mae) || 0,
        p90: winnerMaeP90,
      },
      loserMfe: {
        avg: parseFloat(r.loser_avg_mfe) || 0,
        p75: loserMfeP75,
      },
      recommendations,
    };
  }

  /**
   * Exit reason effectiveness: which exit types produce the best outcomes?
   */
  async _exitReasonBreakdown(userId, cutoff) {
    const { rows } = await db.query(
      `SELECT
         COALESCE(exit_reason, stop_source, 'UNKNOWN') as exit_type,
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
       GROUP BY 1
       ORDER BY total DESC`,
      [userId, cutoff]
    );

    return rows.map(r => ({
      exitType: r.exit_type,
      sampleSize: parseInt(r.total),
      wins: parseInt(r.wins),
      winRate: parseInt(r.total) > 0 ? parseInt(r.wins) / parseInt(r.total) : 0,
      avgPnl: parseFloat(r.avg_pnl) || 0,
      avgPnlPct: parseFloat(r.avg_pnl_pct) || 0,
      avgR: parseFloat(r.avg_r) || 0,
      totalPnl: parseFloat(r.total_pnl) || 0,
    }));
  }

  /**
   * Webhook processing latency analysis.
   */
  async _processingLatency(userId, cutoff) {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) as total,
         ROUND(AVG(EXTRACT(EPOCH FROM (processed_at - received_at)) * 1000)::numeric, 0) as avg_latency_ms,
         ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (processed_at - received_at)) * 1000
         )::numeric, 0) as median_latency_ms,
         ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (processed_at - received_at)) * 1000
         )::numeric, 0) as p95_latency_ms,
         ROUND(MAX(EXTRACT(EPOCH FROM (processed_at - received_at)) * 1000)::numeric, 0) as max_latency_ms
       FROM webhook_events
       WHERE user_id = $1
         AND received_at >= $2
         AND processed_at IS NOT NULL
         AND status = 'PROCESSED'`,
      [userId, cutoff]
    );

    const r = rows[0] || {};

    const latencyTrades = await db.query(
      `SELECT
         CASE
           WHEN EXTRACT(EPOCH FROM (we.processed_at - we.received_at)) * 1000 < 500 THEN '<500ms'
           WHEN EXTRACT(EPOCH FROM (we.processed_at - we.received_at)) * 1000 < 2000 THEN '500ms-2s'
           WHEN EXTRACT(EPOCH FROM (we.processed_at - we.received_at)) * 1000 < 5000 THEN '2-5s'
           ELSE '5s+'
         END as latency_bucket,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE st.pnl > 0) as wins,
         ROUND(AVG(st.pnl)::numeric, 2) as avg_pnl
       FROM webhook_events we
       INNER JOIN sim_trades st ON st.webhook_event_id = we.id
       WHERE we.user_id = $1
         AND we.received_at >= $2
         AND we.processed_at IS NOT NULL
         AND st.exit_time IS NOT NULL
       GROUP BY 1
       ORDER BY 1`,
      [userId, cutoff]
    );

    return {
      totalProcessed: parseInt(r.total) || 0,
      avgLatencyMs: parseInt(r.avg_latency_ms) || 0,
      medianLatencyMs: parseInt(r.median_latency_ms) || 0,
      p95LatencyMs: parseInt(r.p95_latency_ms) || 0,
      maxLatencyMs: parseInt(r.max_latency_ms) || 0,
      latencyImpact: latencyTrades.rows.map(lr => ({
        bucket: lr.latency_bucket,
        sampleSize: parseInt(lr.total),
        wins: parseInt(lr.wins),
        winRate: parseInt(lr.total) > 0 ? parseInt(lr.wins) / parseInt(lr.total) : 0,
        avgPnl: parseFloat(lr.avg_pnl) || 0,
      })),
    };
  }

  /**
   * Evaluate current guard thresholds against historical data.
   * Produces empirical recommendations for each configurable threshold.
   */
  async _guardThresholdAnalysis(userId, cutoff) {
    const thresholds = [];

    // 1. Cooldown analysis: do trades after cooldown perform better?
    const cooldownResult = await db.query(
      `WITH cooldown_periods AS (
         SELECT strategy, created_at as cooldown_start,
                cooldown_until as cooldown_end
         FROM strategy_cooldowns
         WHERE user_id = $1 AND created_at >= $2
       )
       SELECT
         'post_cooldown' as context,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE st.pnl > 0) as wins,
         ROUND(AVG(st.pnl)::numeric, 2) as avg_pnl
       FROM sim_trades st
       WHERE st.user_id = $1
         AND st.entry_time >= $2
         AND st.exit_time IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM strategy_cooldowns sc
           WHERE sc.user_id = $1
             AND sc.strategy = st.strategy
             AND st.entry_time > sc.cooldown_until
             AND st.entry_time < sc.cooldown_until + INTERVAL '2 hours'
         )`,
      [userId, cutoff]
    );

    const postCooldown = cooldownResult.rows[0] || {};
    const pcTotal = parseInt(postCooldown.total) || 0;
    const pcWins = parseInt(postCooldown.wins) || 0;

    thresholds.push({
      guard: 'strategy_cooldown',
      description: 'Pause after consecutive losses',
      currentValue: '3 losses → 60min pause',
      analysis: pcTotal > 0
        ? `Post-cooldown trades: ${pcTotal} total, ${(pcWins / pcTotal * 100).toFixed(0)}% WR, avg PnL $${postCooldown.avg_pnl}`
        : 'No post-cooldown trades in window',
      recommendation: pcTotal >= 5 && (pcWins / pcTotal) < 0.45
        ? 'Cooldown may need to be longer — post-cooldown win rate is below baseline'
        : pcTotal >= 5 && (pcWins / pcTotal) >= 0.55
          ? 'Cooldown is effective — post-cooldown trades are above baseline win rate'
          : 'Insufficient post-cooldown data for recommendation',
    });

    // 2. Max positions: does performance degrade at higher position counts?
    const posCountResult = await db.query(
      `SELECT
         CASE
           WHEN open_positions <= 2 THEN '1-2 positions'
           WHEN open_positions <= 4 THEN '3-4 positions'
           ELSE '5+ positions'
         END as bucket,
         ROUND(AVG(realized_pnl)::numeric, 2) as avg_session_pnl,
         COUNT(*) as snapshots
       FROM sim_equity_snapshots
       WHERE user_id = $1
         AND snapshot_at >= $2
       GROUP BY 1
       ORDER BY 1`,
      [userId, cutoff]
    );

    const positionBuckets = posCountResult.rows.map(r => ({
      bucket: r.bucket,
      avgSessionPnl: parseFloat(r.avg_session_pnl) || 0,
      snapshots: parseInt(r.snapshots),
    }));

    const highPos = positionBuckets.find(p => p.bucket === '5+ positions');
    const lowPos = positionBuckets.find(p => p.bucket === '1-2 positions');
    thresholds.push({
      guard: 'max_open_positions',
      description: 'Maximum concurrent positions',
      currentValue: '5',
      buckets: positionBuckets,
      recommendation: highPos && lowPos && highPos.avgSessionPnl < lowPos.avgSessionPnl
        ? 'Performance degrades at high position counts — consider reducing max positions'
        : 'Current position limit appears appropriate',
    });

    // 3. Signal staleness: do older signals perform worse?
    const stalenessResult = await db.query(
      `SELECT
         CASE
           WHEN EXTRACT(EPOCH FROM (we.processed_at - we.received_at)) < 60 THEN '<1 min'
           WHEN EXTRACT(EPOCH FROM (we.processed_at - we.received_at)) < 180 THEN '1-3 min'
           ELSE '3-5 min'
         END as staleness,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE st.pnl > 0) as wins,
         ROUND(AVG(st.pnl)::numeric, 2) as avg_pnl
       FROM webhook_events we
       INNER JOIN sim_trades st ON st.webhook_event_id = we.id
       WHERE we.user_id = $1
         AND we.received_at >= $2
         AND we.processed_at IS NOT NULL
         AND st.exit_time IS NOT NULL
       GROUP BY 1
       ORDER BY 1`,
      [userId, cutoff]
    );

    const stalenessBuckets = stalenessResult.rows.map(r => ({
      staleness: r.staleness,
      sampleSize: parseInt(r.total),
      wins: parseInt(r.wins),
      winRate: parseInt(r.total) > 0 ? parseInt(r.wins) / parseInt(r.total) : 0,
      avgPnl: parseFloat(r.avg_pnl) || 0,
    }));

    thresholds.push({
      guard: 'signal_staleness',
      description: 'Maximum signal age before discard',
      currentValue: '5 minutes',
      buckets: stalenessBuckets,
      recommendation: stalenessBuckets.length >= 2
        ? this._stalenessRecommendation(stalenessBuckets)
        : 'Insufficient data across staleness tiers',
    });

    // 4. Trading hours: performance outside current window
    const hoursResult = await db.query(
      `SELECT
         CASE
           WHEN EXTRACT(HOUR FROM entry_time AT TIME ZONE 'America/New_York') < 9 THEN 'Pre-market'
           WHEN EXTRACT(HOUR FROM entry_time AT TIME ZONE 'America/New_York') >= 9
            AND EXTRACT(HOUR FROM entry_time AT TIME ZONE 'America/New_York') < 10 THEN 'First hour (9-10)'
           WHEN EXTRACT(HOUR FROM entry_time AT TIME ZONE 'America/New_York') >= 10
            AND EXTRACT(HOUR FROM entry_time AT TIME ZONE 'America/New_York') < 15 THEN 'Mid-day (10-15)'
           WHEN EXTRACT(HOUR FROM entry_time AT TIME ZONE 'America/New_York') >= 15
            AND EXTRACT(HOUR FROM entry_time AT TIME ZONE 'America/New_York') < 16 THEN 'Power hour (15-16)'
           ELSE 'After-hours'
         END as session,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE pnl > 0) as wins,
         ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
         ROUND(SUM(pnl)::numeric, 2) as total_pnl
       FROM sim_trades
       WHERE user_id = $1
         AND exit_time IS NOT NULL
         AND entry_time >= $2
       GROUP BY 1
       ORDER BY total DESC`,
      [userId, cutoff]
    );

    const sessionBuckets = hoursResult.rows.map(r => ({
      session: r.session,
      sampleSize: parseInt(r.total),
      wins: parseInt(r.wins),
      winRate: parseInt(r.total) > 0 ? parseInt(r.wins) / parseInt(r.total) : 0,
      avgPnl: parseFloat(r.avg_pnl) || 0,
      totalPnl: parseFloat(r.total_pnl) || 0,
    }));

    thresholds.push({
      guard: 'trading_hours',
      description: 'Allowed trading window',
      currentValue: '09:00-16:00 ET',
      buckets: sessionBuckets,
      recommendation: this._tradingHoursRecommendation(sessionBuckets),
    });

    return thresholds;
  }

  _stalenessRecommendation(buckets) {
    const fresh = buckets.find(b => b.staleness === '<1 min');
    const stale = buckets.find(b => b.staleness === '3-5 min');
    if (fresh && stale && fresh.winRate > stale.winRate + 0.1) {
      return 'Fresh signals significantly outperform stale ones — consider tightening staleness window to 3 minutes';
    }
    if (fresh && stale && Math.abs(fresh.winRate - stale.winRate) < 0.05) {
      return 'Signal age has minimal impact on outcomes — current 5-minute window is appropriate';
    }
    return 'Mixed results across staleness tiers — monitor with more data';
  }

  _tradingHoursRecommendation(sessions) {
    const losing = sessions.filter(s => s.sampleSize >= 3 && s.winRate < 0.4);
    if (losing.length > 0) {
      const worst = losing.sort((a, b) => a.winRate - b.winRate)[0];
      return `Consider restricting ${worst.session} — ${(worst.winRate * 100).toFixed(0)}% WR, $${worst.totalPnl} total PnL`;
    }
    return 'All trading sessions performing within acceptable range';
  }
}

module.exports = new GuardEffectivenessService();
