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

    sections.push(`You are a professional algorithmic trading system analyst reviewing an automated options trading system's adaptive intelligence dashboard.
Your job: interpret the analytics below and provide actionable, specific recommendations. Ground every claim in the data provided.

RULES:
- Reference specific numbers. Do NOT give generic advice.
- If sample sizes are small (<30 trades), label conclusions as "LOW CONFIDENCE".
- Prioritize findings by impact on P&L.
- Be direct and concise. Traders don't want fluff.

OUTPUT FORMAT (use these exact markdown headers):

# System Health Assessment
A 2-3 sentence verdict on overall system health. Include a score out of 100.

# Critical Findings
Top 3-5 findings that need immediate attention, each with:
- **Finding**: What you observed
- **Evidence**: The specific numbers
- **Action**: What to change and why

# Conviction Engine Diagnosis
Analyze weight drift, calibration health, and whether conviction correlates with outcomes.
Call out any components that are hurting performance.

# Regime & Timing Optimization
Which regime/strategy combinations to lean into vs suppress.
Which hours/days show edge vs which are destroying value.

# Guard & Risk Tuning
Are guards blocking good trades? Are stops/targets well-calibrated?
Specific threshold adjustments with expected impact.

# Priority Action Plan
Numbered list of 5-7 actions in order of expected P&L impact.
Each with: the change, why, how to validate, and guardrail.

DATA (${lookbackDays}-day lookback):`);

    if (calibration) {
      sections.push(`\nCALIBRATION (${calibration.totalTrades} trades):
- Health: ${calibration.calibrationHealth}
- Drifts Detected: ${calibration.driftCount}
- Components:`);
      if (calibration.components) {
        for (const c of calibration.components.slice(0, 18)) {
          sections.push(`  ${c.key}: static=${c.staticWeight}, recommended=${c.recommendedWeight}, drift=${c.weightDrift}, WR_lift=${c.winRateLift}%, present_WR=${(c.present?.winRate * 100 || 0).toFixed(1)}%, absent_WR=${(c.absent?.winRate * 100 || 0).toFixed(1)}%, n=${c.present?.sampleSize || 0}${c.significant ? '' : ' (low n)'}`);
        }
      }
    }

    if (regime) {
      sections.push(`\nREGIME EDGE (${regime.totalTrades} trades):`);
      if (regime.currentImplications) {
        for (const imp of regime.currentImplications) {
          const parts = [];
          if (imp.strong?.length) parts.push(`STRONG in: ${imp.strong.join(', ')}`);
          if (imp.active?.length) parts.push(`ACTIVE in: ${imp.active.join(', ')}`);
          if (imp.suppressed?.length) parts.push(`SUPPRESSED in: ${imp.suppressed.join(', ')}`);
          sections.push(`- ${imp.strategy}: ${parts.join(' | ')}`);
        }
      }
      if (regime.matrix) {
        sections.push('- Matrix:');
        for (const cell of regime.matrix.slice(0, 20)) {
          sections.push(`  ${cell.strategy} × ${cell.regime}: trades=${cell.totalTrades}, WR=${(cell.winRate * 100).toFixed(1)}%, PF=${cell.profitFactor}, PnL=$${cell.totalPnl}, status=${cell.status}`);
        }
      }
    }

    if (temporal) {
      sections.push(`\nTEMPORAL EDGE (base WR: ${(temporal.baseWinRate * 100).toFixed(1)}%):`);
      if (temporal.edgeHours?.length) {
        sections.push('- Edge Hours:');
        for (const e of temporal.edgeHours) {
          sections.push(`  ${e.label}: ${e.direction}, WR delta=${e.winRateDelta > 0 ? '+' : ''}${e.winRateDelta}%, n=${e.sampleSize}`);
        }
      }
      if (temporal.hourSummary) {
        sections.push('- Hour Summary:');
        for (const h of temporal.hourSummary) {
          sections.push(`  ${h.label}: WR=${(h.winRate * 100).toFixed(1)}%, n=${h.sampleSize}`);
        }
      }
    }

    if (signal) {
      sections.push(`\nSIGNAL QUALITY:`);
      if (signal.sourcePerformance) {
        sections.push('- Source Performance:');
        for (const s of signal.sourcePerformance) {
          sections.push(`  ${s.source}: trades=${s.sampleSize}, WR=${(s.winRate * 100).toFixed(1)}%, PF=${s.profitFactor}, avg_pnl=$${s.avgPnl}${s.significant ? '' : ' (low n)'}`);
        }
      }
      if (signal.convictionAccuracy) {
        sections.push(`- Conviction Monotonic: ${signal.convictionAccuracy.isMonotonic ? 'YES' : 'NO'}`);
        sections.push(`- Conviction Note: ${signal.convictionAccuracy.recommendation || 'N/A'}`);
        if (signal.convictionAccuracy.buckets) {
          for (const b of signal.convictionAccuracy.buckets) {
            sections.push(`  ${b.bucket}: WR=${(b.winRate * 100).toFixed(1)}%, avg_pnl=$${b.avgPnl}, n=${b.sampleSize}`);
          }
        }
      }
    }

    if (guard) {
      sections.push(`\nGUARD EFFECTIVENESS:`);
      if (guard.gateBreakdown) {
        sections.push('- Gate Rejections:');
        for (const g of guard.gateBreakdown.slice(0, 10)) {
          sections.push(`  ${g.gate}: ${g.count} rejections (${g.percentage}%)`);
        }
      }
      if (guard.exitQuality) {
        const eq = guard.exitQuality;
        sections.push(`- Exit Quality: winner_MAE_p90=${eq.winnerMaeP90 || 'N/A'}, loser_MFE_p75=${eq.loserMfeP75 || 'N/A'}`);
        if (eq.recommendations) {
          for (const r of eq.recommendations) {
            sections.push(`  Rec: ${r.type} — ${r.suggested}`);
          }
        }
      }
    }

    if (liveCtx) {
      sections.push(`\n${liveCtx}`);
    }

    return sections.join('\n');
  }
}

module.exports = new AIInsightsService();
