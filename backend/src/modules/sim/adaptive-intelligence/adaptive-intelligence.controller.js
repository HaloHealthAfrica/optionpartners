'use strict';

const convictionCalibrator = require('./conviction-calibrator.service');
const regimeEdge = require('./regime-edge.service');
const temporalEdge = require('./temporal-edge.service');
const calibrationStore = require('./calibration-store.service');
const signalQuality = require('./signal-quality.service');
const guardEffectiveness = require('./guard-effectiveness.service');
const logger = require('../../../utils/logger');

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
    res.status(500).json({ error: err.message });
  }
}

async function getCalibrationStatus(req, res) {
  try {
    const status = await calibrationStore.getCalibrationStatus(req.user.id);
    res.json(status);
  } catch (err) {
    logger.error(`Calibration status failed: ${err.message}`, 'adaptive-intelligence');
    res.status(500).json({ error: err.message });
  }
}

async function getActiveWeights(req, res) {
  try {
    const weights = await calibrationStore.getActiveWeights(req.user.id);
    res.json({ weights: weights || [], hasActiveWeights: !!weights });
  } catch (err) {
    logger.error(`Get active weights failed: ${err.message}`, 'adaptive-intelligence');
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
    res.status(500).json({ error: err.message });
  }
}

async function revertCalibration(req, res) {
  try {
    const result = await calibrationStore.revertToStatic(req.user.id);
    res.json(result);
  } catch (err) {
    logger.error(`Revert calibration failed: ${err.message}`, 'adaptive-intelligence');
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
    res.status(500).json({ error: err.message });
  }
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
};
