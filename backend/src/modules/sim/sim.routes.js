'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../../middleware/auth');
const simController = require('./sim.controller');
const intelligenceController = require('./intelligence.controller');
const adaptiveIntelligence = require('./adaptive-intelligence/adaptive-intelligence.controller');
const revenueTargetController = require('./revenue-target/revenue-target.controller');

// All sim routes require authentication
router.use(authenticate);

// Account state
router.get('/account', simController.getAccountState);
router.post('/account/reset', simController.resetAccount);

// Positions & orders
router.get('/positions', simController.getPositions);
router.get('/orders', simController.getOrders);

// Sim trades
router.get('/trades', simController.getTrades);

// Reconciliation endpoint (webhook vs trades)
router.get('/reconcile', simController.reconcileWebhookTrades);

// Equity curve
router.get('/equity-curve', simController.getEquityCurve);

// Analytics
router.get('/analytics/strategy', simController.getStrategyBreakdown);
router.get('/analytics/dte', simController.getDteBreakdown);

// Manual processing trigger
router.post('/process', simController.processPending);

// Kill switch
router.post('/kill-switch', simController.toggleKillSwitch);

// Historical replay
router.post('/replay', simController.startReplay);
router.get('/runs', simController.getSimRuns);

// Webhook backtest (Backtest Lab)
const backtestController = require('./backtest.controller');
router.post('/backtest/preflight', backtestController.preflightBacktest);
router.post('/backtest', backtestController.startBacktest);
router.get('/backtest', backtestController.listBacktests);
router.get('/backtest/:id', backtestController.getBacktest);
router.get('/strategies', backtestController.getStrategies);

// Revenue target (daily target, gate, progress)
router.get('/revenue-target/config', revenueTargetController.getConfig);
router.put('/revenue-target/config', revenueTargetController.updateConfig);
router.get('/revenue-target/progress', revenueTargetController.getProgress);
router.get('/revenue-target/history', revenueTargetController.getHistory);
router.get('/revenue-target/stats', revenueTargetController.getStats);
router.get('/revenue-target/decisions', revenueTargetController.getDecisions);
router.post('/revenue-target/override', revenueTargetController.setOverride);
router.delete('/revenue-target/override', revenueTargetController.clearOverride);

// Status & health
router.get('/status', simController.getStatus);
router.get('/webhook-stats', simController.getWebhookStats);
router.get('/pipeline-observatory', simController.getPipelineObservatory);
router.post('/requeue-rejected', simController.bulkRequeueRejected);
router.get('/health/state', simController.getStateHealth);
router.get('/health/global', simController.getGlobalHealth);

// Connectivity gate (replaces circuit breaker — reset when data-service unreachable)
router.post('/data-service/circuit-breaker/reset', simController.resetDataServiceCircuitBreaker);
router.post('/connectivity/reset', simController.resetDataServiceCircuitBreaker);

// Warmup: seed symbol state with price + chain data from data service
router.post('/warmup/:symbol', simController.warmupSymbol);

// Intelligence layer (Phases 1-5)
router.get('/intelligence/scorecard', intelligenceController.getScorecard);
router.post('/intelligence/scorecard/recalculate', intelligenceController.recalculateScorecard);
router.get('/intelligence/cooldowns', intelligenceController.getCooldowns);
router.delete('/intelligence/cooldowns/:strategy', intelligenceController.clearCooldown);
router.get('/intelligence/rejections', intelligenceController.getRejections);
router.get('/intelligence/positions', intelligenceController.getLivePositions);
router.get('/intelligence/config', intelligenceController.getConfig);
router.put('/intelligence/config', intelligenceController.updateConfig);
router.get('/intelligence/status', intelligenceController.getIntelligenceStatus);
router.get('/intelligence/equity-by-strategy', intelligenceController.getEquityByStrategy);
router.get('/intelligence/verdicts', intelligenceController.getVerdicts);
router.get('/intelligence/snapshot/:symbol', intelligenceController.getSymbolSnapshot);

// Adaptive Intelligence (feedback loop analytics)
router.get('/adaptive/summary', adaptiveIntelligence.getSummary);
router.get('/adaptive/calibration', adaptiveIntelligence.getCalibration);
router.get('/adaptive/regime-edge', adaptiveIntelligence.getRegimeEdge);
router.get('/adaptive/temporal-edge', adaptiveIntelligence.getTemporalEdge);

// Calibration weights management
router.get('/adaptive/calibration/status', adaptiveIntelligence.getCalibrationStatus);
router.get('/adaptive/calibration/weights', adaptiveIntelligence.getActiveWeights);
router.post('/adaptive/calibration/apply', adaptiveIntelligence.applyCalibration);
router.post('/adaptive/calibration/revert', adaptiveIntelligence.revertCalibration);
router.post('/adaptive/calibration/auto-toggle', adaptiveIntelligence.toggleAutoCalibration);
router.put('/adaptive/calibration/threshold', adaptiveIntelligence.setCalibrationThreshold);
router.get('/adaptive/calibration/log', adaptiveIntelligence.getCalibrationLog);

// Signal quality + Guard effectiveness analysis
router.get('/adaptive/signal-quality', adaptiveIntelligence.getSignalQuality);
router.get('/adaptive/guard-effectiveness', adaptiveIntelligence.getGuardEffectiveness);
router.get('/adaptive/strategy-signal-frequency', adaptiveIntelligence.getStrategySignalFrequency);

// AI Insights (LLM interpretation of adaptive data)
router.get('/adaptive/ai-insights', adaptiveIntelligence.getAIInsights);
router.get('/adaptive/ai-insights/stream', adaptiveIntelligence.streamAIInsights);

// Remediation log (tracks fixes applied from health assessments)
router.get('/adaptive/remediation-log', adaptiveIntelligence.getRemediationLog);
router.post('/adaptive/remediation-log', adaptiveIntelligence.addRemediationEntry);
router.post('/adaptive/remediation-log/bulk', adaptiveIntelligence.addRemediationEntries);
router.delete('/adaptive/remediation-log/:id', adaptiveIntelligence.deleteRemediationEntry);

// Live market context
router.get('/adaptive/live-context', adaptiveIntelligence.getLiveContext);

// Auto-insights (triggered by trade count)
router.get('/adaptive/auto-insight', adaptiveIntelligence.getAutoInsight);
router.post('/adaptive/auto-insight/read', adaptiveIntelligence.markAutoInsightRead);

// SSE event stream for real-time updates
router.get('/stream', adaptiveIntelligence.streamEvents);

module.exports = router;
