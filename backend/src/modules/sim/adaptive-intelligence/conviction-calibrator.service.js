'use strict';

const db = require('../../../config/database');
const logger = require('../../../utils/logger');

// Conviction components as they appear in rationale strings (Fix Block 3).
// Patterns must match trade-decision-engine.js rationale format exactly.
// - alignment_score can be decimal (75.5) — use [\d.]+
// - macro produces "macro_strength=X" not "Strong macro"
// - rationale may be string (JSON) or array — normalize in calibrate()
const COMPONENT_PATTERNS = [
  { key: 'strat_align',       pattern: /CONVICTION \+\d+: STRAT direction aligns/,     staticWeight: 10 },
  { key: 'strat_conflict',    pattern: /CONVICTION -\d+: STRAT direction conflicts/,   staticWeight: -10 },
  { key: 'strat_continuity',  pattern: /CONVICTION \+\d+: STRAT continuity/,           staticWeight: 10 },
  { key: 'strat_no_cont',     pattern: /CONVICTION -\d+: STRAT no continuity/,         staticWeight: -15 },
  { key: 'continuation',      pattern: /CONVICTION \+\d+: CONTINUATION pattern/,       staticWeight: 10 },
  { key: 'revstrat',          pattern: /CONVICTION -\d+: REVSTRAT pattern/,            staticWeight: -5 },
  { key: 'trend_high',        pattern: /CONVICTION \+\d+: TREND alignment=[\d.]+ ≥ 75/, staticWeight: 15 },
  { key: 'trend_mid',         pattern: /CONVICTION \+\d+: TREND alignment=[\d.]+ ≥ 65/, staticWeight: 10 },
  { key: 'flow_unusual',      pattern: /CONVICTION \+\d+: Unusual options flow/,       staticWeight: 15 },
  { key: 'flow_aligns',       pattern: /CONVICTION \+\d+: Options flow aligns/,        staticWeight: 8 },
  { key: 'flow_conflict',     pattern: /CONVICTION -\d+: Large opposing flow/,         staticWeight: -5 },
  { key: 'saty_aligns',       pattern: /CONVICTION \+\d+: SATY_PHASE direction aligns/, staticWeight: 8 },
  { key: 'saty_conflict',     pattern: /CONVICTION -\d+: SATY_PHASE direction conflicts/, staticWeight: -5 },
  { key: 'macro_strong',      pattern: /CONVICTION \+\d+: macro_strength=/,             staticWeight: 5 },
  { key: 'iv_high',           pattern: /CONVICTION -\d+: IV_RANK=[\d.]+/,             staticWeight: -5 },
  { key: 'iv_low',            pattern: /CONVICTION \+\d+: IV_RANK=[\d.]+/,            staticWeight: 5 },
  { key: 'gex_negative',      pattern: /CONVICTION \+\d+: GEX strongly negative/,     staticWeight: 8 },
  { key: 'gex_positive',      pattern: /CONVICTION -\d+: GEX strongly positive/,      staticWeight: -8 },
  { key: 'hist_flow_aligns',  pattern: /CONVICTION \+\d+: Historical flow aligns/,    staticWeight: 5 },
  { key: 'hist_flow_conflict', pattern: /CONVICTION -\d+: Historical flow conflicts/, staticWeight: -5 },
];

class ConvictionCalibratorService {
  /**
   * Compute empirical effectiveness of each conviction component.
   * Joins intelligence_verdicts (which store rationale) with sim_trades (which store outcomes).
   */
  async calibrate(userId, options = {}) {
    const minSampleSize = options.minSampleSize || 10;
    const lookbackDays = options.lookbackDays || 90;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lookbackDays);

    // Fetch all approved verdicts that resulted in trades
    const { rows } = await db.query(
      `SELECT
         iv.checks_detail,
         iv.intelligence_score as conviction_score,
         iv.symbol,
         iv.strategy,
         iv.direction,
         iv.created_at as verdict_time,
         st.pnl,
         st.pnl_percent,
         st.r_multiple,
         st.entry_time,
         st.exit_time
       FROM intelligence_verdicts iv
       INNER JOIN sim_trades st ON st.webhook_event_id = iv.webhook_event_id
       WHERE iv.user_id = $1
         AND iv.allowed = true
         AND st.exit_time IS NOT NULL
         AND iv.created_at >= $2
       ORDER BY iv.created_at DESC`,
      [userId, cutoff]
    );

    if (rows.length === 0) {
      return { components: [], totalTrades: 0, lookbackDays, message: 'No completed trades in window' };
    }

    // For each component, compute metrics when present vs absent
    const results = COMPONENT_PATTERNS.map(({ key, pattern, staticWeight }) => {
      const present = [];
      const absent = [];

      for (const row of rows) {
        let rationale = row.checks_detail?.rationale;
        try {
          if (typeof rationale === 'string') rationale = JSON.parse(rationale || '[]');
        } catch (_) {
          rationale = [];
        }
        if (!Array.isArray(rationale)) rationale = [];
        const fired = rationale.some(r => pattern.test(String(r)));

        if (fired) {
          present.push(row);
        } else {
          absent.push(row);
        }
      }

      const presentMetrics = this._computeMetrics(present);
      const absentMetrics = this._computeMetrics(absent);

      // Fix 7: When n<5, WR_lift is a mathematical artifact (present_WR=0 vs absent_WR=60% → -60%).
      // Return null so UI shows N/A instead of misleading values.
      const MIN_DISPLAY_SAMPLE = 5;
      const hasValidSample = presentMetrics.sampleSize >= MIN_DISPLAY_SAMPLE;
      const winRateLift = hasValidSample
        ? Math.round((presentMetrics.winRate - absentMetrics.winRate) * 10000) / 100
        : null;
      const avgRLift = hasValidSample
        ? Math.round((presentMetrics.avgR - absentMetrics.avgR) * 1000) / 1000
        : null;

      // Empirical weight: scale static weight by effectiveness ratio
      let recommendedWeight = staticWeight;
      if (presentMetrics.sampleSize >= minSampleSize && absentMetrics.sampleSize >= minSampleSize) {
        const effectivenessRatio = presentMetrics.winRate > 0
          ? presentMetrics.winRate / Math.max(absentMetrics.winRate, 0.01)
          : 0;
        recommendedWeight = Math.round(staticWeight * effectivenessRatio);
        // Clamp to reasonable bounds
        if (staticWeight > 0) {
          recommendedWeight = Math.max(0, Math.min(25, recommendedWeight));
        } else {
          recommendedWeight = Math.min(0, Math.max(-25, recommendedWeight));
        }
      }

      return {
        key,
        staticWeight,
        recommendedWeight,
        weightDrift: recommendedWeight - staticWeight,
        present: presentMetrics,
        absent: absentMetrics,
        winRateLift,
        avgRLift,
        significant: presentMetrics.sampleSize >= minSampleSize,
      };
    });

    // Overall calibration health
    const significantDrifts = results.filter(r => r.significant && Math.abs(r.weightDrift) >= 3);
    // Fix 4 (Warning 4): Calibration Coverage Score — components with n≥5 / total
    const MIN_COVERAGE_SAMPLE = 5;
    const coveredCount = results.filter(r => r.present.sampleSize >= MIN_COVERAGE_SAMPLE).length;
    const calibrationCoverageScore = results.length > 0 ? coveredCount / results.length : 0;
    const calibrationCoverageWarning = calibrationCoverageScore < 0.5 ? 'LOW_COVERAGE' : null;

    return {
      components: results,
      totalTrades: rows.length,
      lookbackDays,
      calibrationHealth: significantDrifts.length === 0 ? 'ALIGNED' : 'DRIFT_DETECTED',
      driftCount: significantDrifts.length,
      calibrationCoverageScore: Math.round(calibrationCoverageScore * 100) / 100,
      calibrationCoverageWarning,
      coveredComponents: coveredCount,
      totalComponents: results.length,
      computedAt: Date.now(),
    };
  }

  _computeMetrics(trades) {
    if (trades.length === 0) {
      return { sampleSize: 0, winRate: 0, avgPnl: 0, avgR: 0, totalPnl: 0, profitFactor: 0 };
    }

    const wins = trades.filter(t => parseFloat(t.pnl) > 0);
    const losses = trades.filter(t => parseFloat(t.pnl) <= 0);
    const winRate = wins.length / trades.length;

    const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.pnl), 0);
    const avgPnl = totalPnl / trades.length;

    const rValues = trades.filter(t => t.r_multiple != null).map(t => parseFloat(t.r_multiple));
    const avgR = rValues.length > 0 ? rValues.reduce((a, b) => a + b, 0) / rValues.length : 0;

    const grossWins = wins.reduce((sum, t) => sum + parseFloat(t.pnl), 0);
    const grossLosses = Math.abs(losses.reduce((sum, t) => sum + parseFloat(t.pnl), 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 999 : 0);
    const profitFactorIsSentinel = profitFactor === 999;

    return {
      sampleSize: trades.length,
      winRate: Math.round(winRate * 10000) / 10000,
      avgPnl: Math.round(avgPnl * 100) / 100,
      avgR: Math.round(avgR * 1000) / 1000,
      totalPnl: Math.round(totalPnl * 100) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      profitFactorIsSentinel,
    };
  }
}

module.exports = new ConvictionCalibratorService();
