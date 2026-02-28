'use strict';

const convictionCalibrator = require('./conviction-calibrator.service');
const regimeEdge = require('./regime-edge.service');
const temporalEdge = require('./temporal-edge.service');
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

module.exports = {
  getCalibration,
  getRegimeEdge,
  getTemporalEdge,
  getSummary,
};
