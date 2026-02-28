'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../../middleware/auth');
const simController = require('./sim.controller');
const intelligenceController = require('./intelligence.controller');
const adaptiveIntelligence = require('./adaptive-intelligence/adaptive-intelligence.controller');

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

// Status
router.get('/status', simController.getStatus);

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

module.exports = router;
