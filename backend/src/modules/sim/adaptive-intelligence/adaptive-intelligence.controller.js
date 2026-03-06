'use strict';

const convictionCalibrator = require('./conviction-calibrator.service');
const regimeEdge = require('./regime-edge.service');
const temporalEdge = require('./temporal-edge.service');
const calibrationStore = require('./calibration-store.service');
const signalQuality = require('./signal-quality.service');
const guardEffectiveness = require('./guard-effectiveness.service');
const logger = require('../../../utils/logger');
const Sentry = require('@sentry/node');

async function getCalibration(req, res) {
  try {
    const lookbackDays = parseInt(req.query.lookbackDays || '90', 10);
    const minSampleSize = parseInt(req.query.minSampleSize || '10', 10);

    const result = await convictionCalibrator.calibrate(req.user.id, {
      lookbackDays,
      minSampleSize,
    });

    res.json(result);
  } catch (err) {
    logger.error(`Calibration failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

async function getRegimeEdge(req, res) {
  try {
    const lookbackDays = parseInt(req.query.lookbackDays || '90', 10);
    const minSampleSize = parseInt(req.query.minSampleSize || '5', 10);

    const result = await regimeEdge.analyze(req.user.id, {
      lookbackDays,
      minSampleSize,
    });

    res.json(result);
  } catch (err) {
    logger.error(`Regime edge analysis failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

async function getTemporalEdge(req, res) {
  try {
    const lookbackDays = parseInt(req.query.lookbackDays || '90', 10);
    const minSampleSize = parseInt(req.query.minSampleSize || '3', 10);

    const result = await temporalEdge.analyze(req.user.id, {
      lookbackDays,
      minSampleSize,
    });

    res.json(result);
  } catch (err) {
    logger.error(`Temporal edge analysis failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

async function getSummary(req, res) {
  try {
    const lookbackDays = parseInt(req.query.lookbackDays || '90', 10);

    const [calibration, regime, temporal] = await Promise.all([
      convictionCalibrator.calibrate(req.user.id, { lookbackDays, minSampleSize: 10 }),
      regimeEdge.analyze(req.user.id, { lookbackDays, minSampleSize: 5 }),
      temporalEdge.analyze(req.user.id, { lookbackDays, minSampleSize: 3 }),
    ]);

    res.json({
      calibration: {
        health: calibration.calibrationHealth,
        driftCount: calibration.driftCount,
        totalTrades: calibration.totalTrades,
      },
      regime: {
        totalTrades: regime.totalTrades,
        strategies: regime.strategies?.length || 0,
        implications: regime.currentImplications,
      },
      temporal: {
        totalTrades: temporal.totalTrades,
        edgeHours: temporal.edgeHours,
        baseWinRate: temporal.baseWinRate,
      },
      lookbackDays,
      computedAt: Date.now(),
    });
  } catch (err) {
    logger.error(`Adaptive intelligence summary failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

async function getCalibrationStatus(req, res) {
  try {
    const status = await calibrationStore.getCalibrationStatus(req.user.id);
    res.json(status);
  } catch (err) {
    logger.error(`Calibration status failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

async function getActiveWeights(req, res) {
  try {
    const weights = await calibrationStore.getActiveWeights(req.user.id);
    res.json({ weights: weights || [], hasActiveWeights: !!weights });
  } catch (err) {
    logger.error(`Get active weights failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

async function applyCalibration(req, res) {
  try {
    const lookbackDays = parseInt(req.body.lookbackDays || '90', 10);
    const calResult = await convictionCalibrator.calibrate(req.user.id, { lookbackDays, minSampleSize: 10 });

    if (calResult.totalTrades < 10) {
      return res.status(400).json({ error: 'Insufficient trades for calibration (min 10)' });
    }

    const result = await calibrationStore.applyCalibration(req.user.id, calResult.components, 'MANUAL');
    res.json({ ...result, calibration: calResult });
  } catch (err) {
    logger.error(`Apply calibration failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

async function revertCalibration(req, res) {
  try {
    const result = await calibrationStore.revertToStatic(req.user.id);
    res.json(result);
  } catch (err) {
    logger.error(`Revert calibration failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

async function toggleAutoCalibration(req, res) {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const result = await calibrationStore.toggleAutoCalibration(req.user.id, enabled);
    res.json(result);
  } catch (err) {
    logger.error(`Toggle auto-calibration failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

async function setCalibrationThreshold(req, res) {
  try {
    const { threshold } = req.body;
    if (!threshold || typeof threshold !== 'number') {
      return res.status(400).json({ error: 'threshold must be a number' });
    }
    const result = await calibrationStore.setThreshold(req.user.id, threshold);
    res.json(result);
  } catch (err) {
    logger.error(`Set threshold failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

async function getCalibrationLog(req, res) {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const log = await calibrationStore.getLog(req.user.id, limit);
    res.json({ log, count: log.length });
  } catch (err) {
    logger.error(`Get calibration log failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

async function getSignalQuality(req, res) {
  try {
    const lookbackDays = parseInt(req.query.lookbackDays || '90', 10);
    const minSampleSize = parseInt(req.query.minSampleSize || '5', 10);
    const result = await signalQuality.analyze(req.user.id, { lookbackDays, minSampleSize });
    res.json(result);
  } catch (err) {
    logger.error(`Signal quality analysis failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

async function getGuardEffectiveness(req, res) {
  try {
    const lookbackDays = parseInt(req.query.lookbackDays || '90', 10);
    const result = await guardEffectiveness.analyze(req.user.id, { lookbackDays });
    res.json(result);
  } catch (err) {
    logger.error(`Guard effectiveness analysis failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });
    res.status(500).json({ error: err.message });
  }
}

// AI Insights — LLM interpretation of adaptive intelligence data
const aiInsightsService = require('./ai-insights.service');
const autoInsightService = require('./auto-insight.service');
const liveContextService = require('./live-context.service');
const simEventBus = require('../sim-event-bus');
const AIProvider = require('../../../utils/aiProvider');
const AICreditService = require('../../../services/aiCreditService');

async function getAIInsights(req, res) {
  try {
    const lookbackDays = parseInt(req.query.lookbackDays || '90', 10);
    const result = await aiInsightsService.generateInsights(req.user.id, { lookbackDays });
    res.json(result);
  } catch (err) {
    logger.error(`AI insights failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });

    if (err.message.includes('Insufficient credits')) {
      return res.status(402).json({ error: err.message });
    }
    if (err.message.includes('No completed trades')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
}

async function streamAIInsights(req, res) {
  try {
    const lookbackDays = parseInt(req.query.lookbackDays || '90', 10);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const { prompt, aiSettings, dataSnapshot } = await aiInsightsService.prepareInsightsStream(
      req.user.id, { lookbackDays }
    );

    res.write(`data: ${JSON.stringify({ type: 'start', dataSnapshot })}\n\n`);

    const fullText = await AIProvider.generateStreamingResponse(prompt, aiSettings, res);

    logger.info(`[AI_INSIGHTS] Stream completed: ${fullText?.length || 0} chars for user ${req.user.id}`, 'adaptive-intelligence');

    await AICreditService.useCredits(req.user.id, AICreditService.getCost('NEW_SESSION'));

    const preview = fullText ? fullText.substring(0, 100) + '...' : '(empty response)';
    res.write(`data: ${JSON.stringify({ type: 'done', fullText: preview })}\n\n`);
    res.end();
  } catch (err) {
    logger.error(`Stream AI insights failed: ${err.message}`, 'adaptive-intelligence');
    Sentry.captureException(err, { tags: { module: 'adaptive-intelligence-controller' } });

    if (!res.headersSent) {
      if (err.message.includes('Insufficient credits')) {
        return res.status(402).json({ error: err.message });
      }
      return res.status(500).json({ error: err.message });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
}

async function getLiveContext(req, res) {
  try {
    const ctx = await liveContextService.buildContext(req.user.id);
    res.json(ctx);
  } catch (err) {
    logger.error(`Live context failed: ${err.message}`, 'adaptive-intelligence');
    res.status(500).json({ error: err.message });
  }
}

async function getAutoInsight(req, res) {
  try {
    const insight = await autoInsightService.getLatestInsight(req.user.id);
    const unread = await autoInsightService.getUnreadCount(req.user.id);
    res.json({ insight, unreadCount: unread });
  } catch (err) {
    logger.error(`Auto insight fetch failed: ${err.message}`, 'adaptive-intelligence');
    res.status(500).json({ error: err.message });
  }
}

async function markAutoInsightRead(req, res) {
  try {
    await autoInsightService.markRead(req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function streamEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

  const clientId = simEventBus.addClient(req.user.id, res);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    simEventBus.removeClient(req.user.id, clientId);
  });
}

module.exports = {
  getCalibration,
  getRegimeEdge,
  getTemporalEdge,
  getSummary,
  getCalibrationStatus,
  getActiveWeights,
  applyCalibration,
  revertCalibration,
  toggleAutoCalibration,
  setCalibrationThreshold,
  getCalibrationLog,
  getSignalQuality,
  getGuardEffectiveness,
  getAIInsights,
  streamAIInsights,
  getLiveContext,
  getAutoInsight,
  markAutoInsightRead,
  streamEvents,
};
