'use strict';

const convictionCalibrator = require('./conviction-calibrator.service');
const regimeEdge = require('./regime-edge.service');
const temporalEdge = require('./temporal-edge.service');
const signalQuality = require('./signal-quality.service');
const guardEffectiveness = require('./guard-effectiveness.service');
const liveContext = require('./live-context.service');
const AIProvider = require('../../../utils/aiProvider');
const AISessionService = require('../../../services/aiSessionService');
const AICreditService = require('../../../services/aiCreditService');
const logger = require('../../../utils/logger');

/**
 * AI Insights Service — Interprets adaptive intelligence data with LLM.
 *
 * Gathers all analytics (calibration, regime, temporal, signal quality,
 * guard effectiveness) plus live market context, then sends to AI for
 * a structured interpretation with actionable recommendations.
 */
class AIInsightsService {
  /**
   * Generate AI insights from adaptive intelligence data.
   * @param {string} userId
   * @param {Object} options
   * @param {number} [options.lookbackDays=90]
   * @param {boolean} [options.includeLiveContext=true]
   * @returns {Promise<Object>} { analysis, dataSnapshot, creditsUsed }
   */
  async generateInsights(userId, options = {}) {
    const { lookbackDays = 90, includeLiveContext = true } = options;

    const creditCheck = await AICreditService.hasCredits(userId, AICreditService.getCost('NEW_SESSION'));
    if (!creditCheck.allowed) {
      throw new Error(creditCheck.message || 'Insufficient credits for AI insights');
    }

    const [calibration, regime, temporal, signal, guard, liveCtx] = await Promise.all([
      convictionCalibrator.calibrate(userId, { lookbackDays, minSampleSize: 10 }).catch(() => null),
      regimeEdge.analyze(userId, { lookbackDays, minSampleSize: 5 }).catch(() => null),
      temporalEdge.analyze(userId, { lookbackDays, minSampleSize: 3 }).catch(() => null),
      signalQuality.analyze(userId, { lookbackDays, minSampleSize: 5 }).catch(() => null),
      guardEffectiveness.analyze(userId, { lookbackDays }).catch(() => null),
      includeLiveContext ? liveContext.buildContextBlock(userId) : Promise.resolve(''),
    ]);

    const totalTrades = calibration?.totalTrades || regime?.totalTrades || temporal?.totalTrades || 0;
    if (totalTrades === 0) {
      throw new Error('No completed trades to analyze. The system needs trade outcomes to generate insights.');
    }

    const prompt = this._buildPrompt(calibration, regime, temporal, signal, guard, liveCtx, lookbackDays);
    const aiSettings = await AISessionService.getAISettings(userId, options);

    logger.info(`[AI_INSIGHTS] Generating insights for user ${userId} (${totalTrades} trades, ${lookbackDays}d lookback)`, 'ai-insights');
    const analysis = await AIProvider.generateResponse(prompt, aiSettings);

    const creditsResult = await AICreditService.useCredits(userId, AICreditService.getCost('NEW_SESSION'));

    return {
      analysis,
      dataSnapshot: {
        totalTrades,
        lookbackDays,
        calibrationHealth: calibration?.calibrationHealth,
        driftCount: calibration?.driftCount || 0,
        edgeHours: temporal?.edgeHours?.length || 0,
        baseWinRate: temporal?.baseWinRate,
        regimeCount: regime?.matrix?.length || 0,
      },
      creditsUsed: AICreditService.getCost('NEW_SESSION'),
      creditsRemaining: creditsResult.remaining,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Stream AI insights (returns an async generator of text chunks).
   * @param {string} userId
   * @param {Object} options
   * @returns {Promise<{ prompt, aiSettings, dataSnapshot }>} Data needed to stream
   */
  async prepareInsightsStream(userId, options = {}) {
    const { lookbackDays = 90, includeLiveContext = true } = options;

    const creditCheck = await AICreditService.hasCredits(userId, AICreditService.getCost('NEW_SESSION'));
    if (!creditCheck.allowed) {
      throw new Error(creditCheck.message || 'Insufficient credits for AI insights');
    }

    const [calibration, regime, temporal, signal, guard, liveCtx] = await Promise.all([
      convictionCalibrator.calibrate(userId, { lookbackDays, minSampleSize: 10 }).catch(() => null),
      regimeEdge.analyze(userId, { lookbackDays, minSampleSize: 5 }).catch(() => null),
      temporalEdge.analyze(userId, { lookbackDays, minSampleSize: 3 }).catch(() => null),
      signalQuality.analyze(userId, { lookbackDays, minSampleSize: 5 }).catch(() => null),
      guardEffectiveness.analyze(userId, { lookbackDays }).catch(() => null),
      includeLiveContext ? liveContext.buildContextBlock(userId) : Promise.resolve(''),
    ]);

    const totalTrades = calibration?.totalTrades || regime?.totalTrades || temporal?.totalTrades || 0;
    if (totalTrades === 0) {
      throw new Error('No completed trades to analyze.');
    }

    const prompt = this._buildPrompt(calibration, regime, temporal, signal, guard, liveCtx, lookbackDays);
    const aiSettings = await AISessionService.getAISettings(userId, options);

    return {
      prompt,
      aiSettings,
      dataSnapshot: {
        totalTrades,
        lookbackDays,
        calibrationHealth: calibration?.calibrationHealth,
        driftCount: calibration?.driftCount || 0,
        edgeHours: temporal?.edgeHours?.length || 0,
        baseWinRate: temporal?.baseWinRate,
      },
    };
  }

  _buildPrompt(calibration, regime, temporal, signal, guard, liveCtx, lookbackDays) {
    const sections = [];

    sections.push(`You are analyzing the performance of an automated options trading system using simulation trading data, signal processing metrics, conviction engine statistics, and strategy performance summaries.

Your job is not only to describe what is happening, but to produce **precise, actionable remediation plans** that can be implemented safely.

Avoid generic advice. Every major finding must include a proposed fix, validation method, and safety guardrails.

---

### ANALYSIS OBJECTIVES

You must determine:

• Whether profitable strategies are being blocked by system filters
• Whether conviction thresholds or guards are too strict
• Whether regime classification or analytics pipelines are degrading signal interpretation
• Whether strategies are underperforming and should be suspended
• Whether sample sizes are too small to justify action
• Whether metrics such as MAE/MFE or regime tags appear corrupted or unreliable

Your output must convert diagnostics into **testable engineering actions**.

---

### STATISTICAL CONFIDENCE RULES

You must label conclusions based on sample size:

n < 5 → INSUFFICIENT_SAMPLE
5 ≤ n < 15 → LOW_CONFIDENCE
15 ≤ n < 30 → MEDIUM_CONFIDENCE
n ≥ 30 → HIGH_CONFIDENCE

Never recommend structural system changes based on LOW_CONFIDENCE results. Instead suggest simulation testing.

---

### BEHAVIORAL RULES

You must:
• prefer targeted adjustments over broad system changes
• clearly distinguish hypotheses from confirmed issues
• prioritize high expected impact fixes
• avoid vague recommendations

If you recommend changing thresholds, always provide a **reasonable adjustment range** rather than a single number.

Example: "Test reducing conviction threshold by 5–10 points for STRAT_Failed2 signals in simulation."

---

### STRUCTURE OF THE OUTPUT (use these exact markdown headers)

# System Health Assessment

Summarize the system's overall condition using metrics such as:
* trade acceptance rate
* rejection concentration by subsystem
* total trade sample size
* strategy-level performance distribution

Provide a **System Health Score (0–100)** and explain what factors drive the score.

---

# Critical Findings

Identify the most important issues affecting system performance (top 3-5).

Each finding must include:
- **Issue**: What you observed
- **Evidence**: The specific numbers
- **Why it matters**: Impact on P&L or system reliability

---

# Root Cause Hypotheses

For each major issue, propose the most likely root cause.

Examples:
* conviction threshold too high
* adaptive guard rejecting trades due to regime misclassification
* expected move filter too strict in high-IV environments
* underperforming strategy family dragging P&L
* missing regime tags causing guard misfires

If data is insufficient, explicitly label the hypothesis as **LOW CONFIDENCE**.

---

# Prescribed Fix Plan

For every major issue, produce a remediation block with:

- **Issue**
- **Evidence**
- **Root Cause Hypothesis**
- **Likely Subsystem or Module**
- **Prescribed Fix**
- **Exact Parameter or Logic Change to Test**
- **Safety Level**: one of SAFE_LIVE | SIM_ONLY | MONITOR_ONLY | DO_NOT_TOUCH_YET
- **Validation Method**
- **Rollback Trigger**
- **Confidence Level**
- **Expected Impact**

Instead of saying "loosen filters," specify:
* reduce conviction threshold by 5–10 points for specific strategies
* widen expected move guard by 10–15% during high volatility regimes
* restrict entries to specific session windows

---

# Strategy Performance Diagnosis

Evaluate each strategy family separately. Classify strategies into:

- **LEAN INTO** – strong evidence of edge
- **MONITOR** – possible edge but sample too small
- **SUPPRESS** – negative expectancy
- **INSUFFICIENT SAMPLE** – no reliable conclusion

For suppressed strategies, recommend: suspension, paper trading only, or further data collection.

---

# Guard and Risk Tuning

Analyze rejection data to determine if filters are too aggressive.

Provide explicit diagnostics for:
* TRADE_ENGINE rejections
* ADAPTIVE_GUARD rejections
* EXPECTED_MOVE filters
* SAFETY_GUARD triggers

For each guard type:
• explain its rejection contribution
• identify whether it is likely blocking profitable setups
• suggest threshold adjustments where appropriate

---

# Timing and Regime Optimization

Analyze whether trade performance varies by:
* time of day
* market regime
* volatility environment

If one window dominates profitability, recommend explicit session filters until more data exists.
If regime classification appears unreliable (e.g., many trades marked UNKNOWN), recommend diagnosing regime tagging rather than modifying strategies.

---

# Data Integrity Warnings

Before recommending structural changes, verify that analytics metrics appear credible.

Flag any of the following:
* extremely large MAE/MFE percentages
* unit inconsistencies (percent vs basis points)
* metrics derived from very small sample sizes

If suspicious metrics are detected, label them: **DATA_INTEGRITY_WARNING** and recommend auditing the calculation before acting.

---

# Priority Action Plan

Produce a ranked list of the highest-impact fixes. Each action must include:

| Priority | Fix | Subsystem | Safety Level | Confidence | Expected Impact | Validation Window | Rollback Trigger |

Prioritize fixes that:
* unlock profitable setups
* remove losing strategies
* improve data reliability
* increase calibration data volume

---

### GOAL

Produce a **remediation blueprint** that allows engineers and traders to improve the system safely without introducing additional risk.
Your report should read like a **trading system triage plan written by an experienced quant engineer**, not a general commentary on performance.

---

DATA (${lookbackDays}-day lookback):`);

    if (calibration) {
      sections.push(`\n## CONVICTION CALIBRATION DATA (${calibration.totalTrades} trades):
- Calibration Health: ${calibration.calibrationHealth}
- Drifts Detected: ${calibration.driftCount}
- Component Breakdown:`);
      if (calibration.components) {
        for (const c of calibration.components.slice(0, 25)) {
          const confidence = (c.present?.sampleSize || 0) >= 30 ? 'HIGH_CONFIDENCE'
            : (c.present?.sampleSize || 0) >= 15 ? 'MEDIUM_CONFIDENCE'
            : (c.present?.sampleSize || 0) >= 5 ? 'LOW_CONFIDENCE'
            : 'INSUFFICIENT_SAMPLE';
          sections.push(`  ${c.key}: static_wt=${c.staticWeight}, recommended_wt=${c.recommendedWeight}, drift=${c.weightDrift}, WR_lift=${c.winRateLift}%, present_WR=${(c.present?.winRate * 100 || 0).toFixed(1)}%, absent_WR=${(c.absent?.winRate * 100 || 0).toFixed(1)}%, n=${c.present?.sampleSize || 0} [${confidence}]`);
        }
      }
    }

    if (regime) {
      sections.push(`\n## REGIME EDGE DATA (${regime.totalTrades} trades):`);
      if (regime.currentImplications) {
        sections.push('- Current Regime Implications:');
        for (const imp of regime.currentImplications) {
          const parts = [];
          if (imp.strong?.length) parts.push(`STRONG: ${imp.strong.join(', ')}`);
          if (imp.active?.length) parts.push(`ACTIVE: ${imp.active.join(', ')}`);
          if (imp.suppressed?.length) parts.push(`SUPPRESSED: ${imp.suppressed.join(', ')}`);
          sections.push(`  ${imp.strategy}: ${parts.join(' | ')}`);
        }
      }
      if (regime.matrix) {
        sections.push('- Strategy × Regime Matrix:');
        for (const cell of regime.matrix.slice(0, 25)) {
          const confidence = cell.totalTrades >= 30 ? 'HIGH_CONFIDENCE'
            : cell.totalTrades >= 15 ? 'MEDIUM_CONFIDENCE'
            : cell.totalTrades >= 5 ? 'LOW_CONFIDENCE'
            : 'INSUFFICIENT_SAMPLE';
          sections.push(`  ${cell.strategy} × ${cell.regime}: trades=${cell.totalTrades}, WR=${(cell.winRate * 100).toFixed(1)}%, PF=${cell.profitFactor}, PnL=$${cell.totalPnl}, status=${cell.status} [${confidence}]`);
        }
      }
    }

    if (temporal) {
      sections.push(`\n## TEMPORAL EDGE DATA (base WR: ${(temporal.baseWinRate * 100).toFixed(1)}%):`);
      if (temporal.edgeHours?.length) {
        sections.push('- Statistically Significant Edge Hours:');
        for (const e of temporal.edgeHours) {
          const confidence = e.sampleSize >= 30 ? 'HIGH_CONFIDENCE'
            : e.sampleSize >= 15 ? 'MEDIUM_CONFIDENCE'
            : e.sampleSize >= 5 ? 'LOW_CONFIDENCE'
            : 'INSUFFICIENT_SAMPLE';
          sections.push(`  ${e.label}: ${e.direction}, WR_delta=${e.winRateDelta > 0 ? '+' : ''}${e.winRateDelta}%, n=${e.sampleSize} [${confidence}]`);
        }
      }
      if (temporal.hourSummary) {
        sections.push('- Full Hour Summary:');
        for (const h of temporal.hourSummary) {
          sections.push(`  ${h.label}: WR=${(h.winRate * 100).toFixed(1)}%, n=${h.sampleSize}`);
        }
      }
    }

    if (signal) {
      sections.push(`\n## SIGNAL QUALITY DATA:`);
      if (signal.sourcePerformance) {
        sections.push('- Signal Source Performance:');
        for (const s of signal.sourcePerformance) {
          const confidence = s.sampleSize >= 30 ? 'HIGH_CONFIDENCE'
            : s.sampleSize >= 15 ? 'MEDIUM_CONFIDENCE'
            : s.sampleSize >= 5 ? 'LOW_CONFIDENCE'
            : 'INSUFFICIENT_SAMPLE';
          sections.push(`  ${s.source}: trades=${s.sampleSize}, WR=${(s.winRate * 100).toFixed(1)}%, PF=${s.profitFactor}, avg_pnl=$${s.avgPnl} [${confidence}]`);
        }
      }
      if (signal.convictionAccuracy) {
        sections.push(`- Conviction Monotonicity: ${signal.convictionAccuracy.isMonotonic ? 'YES (higher conviction = higher WR)' : 'NO (conviction does NOT correlate with outcomes — calibration issue)'}`);
        sections.push(`- Conviction Diagnostic: ${signal.convictionAccuracy.recommendation || 'N/A'}`);
        if (signal.convictionAccuracy.buckets) {
          sections.push('- Conviction Bucket Breakdown:');
          for (const b of signal.convictionAccuracy.buckets) {
            sections.push(`  ${b.bucket}: WR=${(b.winRate * 100).toFixed(1)}%, avg_pnl=$${b.avgPnl}, n=${b.sampleSize}`);
          }
        }
      }
    }

    if (guard) {
      sections.push(`\n## GUARD EFFECTIVENESS DATA:`);
      if (guard.gateBreakdown) {
        sections.push('- Gate Rejection Breakdown (trades blocked by each filter):');
        for (const g of guard.gateBreakdown.slice(0, 15)) {
          sections.push(`  ${g.gate}: ${g.count} rejections (${g.percentage}% of total rejections)`);
        }
      }
      if (guard.exitQuality) {
        const eq = guard.exitQuality;
        sections.push(`- Exit Quality Metrics:`);
        sections.push(`  winner_MAE_p90=${eq.winnerMaeP90 || 'N/A'} (how far winners go against you before recovering)`);
        sections.push(`  loser_MFE_p75=${eq.loserMfeP75 || 'N/A'} (how far losers go in your favor before reversing)`);
        if (eq.recommendations) {
          sections.push('- Exit Tuning Recommendations:');
          for (const r of eq.recommendations) {
            sections.push(`  ${r.type}: ${r.suggested}`);
          }
        }
      }
    }

    if (liveCtx) {
      sections.push(`\n## CURRENT LIVE MARKET CONTEXT:\n${liveCtx}`);
    }

    return sections.join('\n');
  }
}

module.exports = new AIInsightsService();
