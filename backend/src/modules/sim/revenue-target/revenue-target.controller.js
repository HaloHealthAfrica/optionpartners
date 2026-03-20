'use strict';

const revenueTargetConfig = require('./revenue-target-config.service');
const revenueTargetProgress = require('./revenue-target-progress.service');
const revenueTargetGate = require('./revenue-target-gate');
const revenueTargetDecisionLog = require('./revenue-target-decision-log.service');
const globalMarketState = require('../global-market-state.service');
const dataServiceProxy = require('../../../services/dataServiceProxy');
const logger = require('../../../utils/logger');
const Sentry = require('@sentry/node');

/**
 * GET /api/sim/revenue-target/config
 */
async function getConfig(req, res) {
  try {
    const config = await revenueTargetConfig.getConfig(req.user.id);
    res.json(config);
  } catch (error) {
    logger.error(`Revenue target getConfig failed: ${error.message}`, 'revenue-target');
    Sentry.captureException(error, { tags: { module: 'revenue-target' } });
    res.status(500).json({ error: 'Failed to get revenue target config' });
  }
}

/**
 * PUT /api/sim/revenue-target/config
 */
async function updateConfig(req, res) {
  try {
    const config = await revenueTargetConfig.upsertConfig(req.user.id, req.body);
    res.json(config);
  } catch (error) {
    logger.error(`Revenue target updateConfig failed: ${error.message}`, 'revenue-target');
    Sentry.captureException(error, { tags: { module: 'revenue-target' } });
    res.status(500).json({ error: 'Failed to update revenue target config' });
  }
}

/**
 * GET /api/sim/revenue-target/progress
 */
async function getProgress(req, res) {
  try {
    const [progress, gate, config, gmsState, dataHealth] = await Promise.all([
      revenueTargetProgress.getTodayProgress(req.user.id),
      revenueTargetGate.shouldAllowNewTrades(req.user.id),
      revenueTargetConfig.getConfig(req.user.id),
      globalMarketState.getState('SPY'),
      dataServiceProxy.getHealth().catch(() => ({ reachable: false })),
    ]);
    if (config.enabled) {
      revenueTargetProgress.recordDailySnapshot(req.user.id, config.dailyTarget).catch(() => {});
    }
    const spyPrice = gmsState?.last_price ? parseFloat(gmsState.last_price) : null;
    const servicesHealthy = dataHealth?.reachable !== false;
    res.json({
      ...progress,
      target: config.dailyTarget,
      remainingTarget: Math.max(0, config.dailyTarget - progress.realizedToday),
      gateAllowed: gate.allowed,
      gateReason: gate.reason,
      spyPrice,
      servicesHealthy,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`Revenue target getProgress failed: ${error.message}`, 'revenue-target');
    Sentry.captureException(error, { tags: { module: 'revenue-target' } });
    res.status(500).json({ error: 'Failed to get revenue target progress' });
  }
}

/**
 * GET /api/sim/revenue-target/history
 */
async function getHistory(req, res) {
  try {
    const days = parseInt(req.query.days) || 14;
    const history = await revenueTargetProgress.getRecentProgress(req.user.id, days);
    res.json({ history });
  } catch (error) {
    logger.error(`Revenue target getHistory failed: ${error.message}`, 'revenue-target');
    Sentry.captureException(error, { tags: { module: 'revenue-target' } });
    res.status(500).json({ error: 'Failed to get revenue target history' });
  }
}

/**
 * GET /api/sim/revenue-target/stats
 */
async function getStats(req, res) {
  try {
    const days = parseInt(req.query.days) || 14;
    const stats = await revenueTargetProgress.getRollingStats(req.user.id, days);
    res.json(stats);
  } catch (error) {
    logger.error(`Revenue target getStats failed: ${error.message}`, 'revenue-target');
    Sentry.captureException(error, { tags: { module: 'revenue-target' } });
    res.status(500).json({ error: 'Failed to get revenue target stats' });
  }
}

/**
 * GET /api/sim/revenue-target/decisions
 */
async function getDecisions(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const decisions = await revenueTargetDecisionLog.getRecentDecisions(req.user.id, limit);
    res.json({ decisions });
  } catch (error) {
    logger.error(`Revenue target getDecisions failed: ${error.message}`, 'revenue-target');
    Sentry.captureException(error, { tags: { module: 'revenue-target' } });
    res.status(500).json({ error: 'Failed to get revenue target decisions' });
  }
}

/**
 * POST /api/sim/revenue-target/override
 * Set override gate until end of session (e.g. 4 hours from now).
 */
async function setOverride(req, res) {
  try {
    const hours = parseInt(req.body?.hours) || 4;
    const until = new Date(Date.now() + hours * 60 * 60 * 1000);
    const config = await revenueTargetConfig.setOverrideGateUntil(req.user.id, until);
    await revenueTargetProgress.recordOverrideUsed(req.user.id);
    res.json({ overrideGateUntil: config.overrideGateUntil, message: `Gate override active until ${until.toISOString()}` });
  } catch (error) {
    logger.error(`Revenue target setOverride failed: ${error.message}`, 'revenue-target');
    Sentry.captureException(error, { tags: { module: 'revenue-target' } });
    res.status(500).json({ error: 'Failed to set override' });
  }
}

/**
 * DELETE /api/sim/revenue-target/override
 */
async function clearOverride(req, res) {
  try {
    await revenueTargetConfig.setOverrideGateUntil(req.user.id, null);
    res.json({ overrideGateUntil: null, message: 'Override cleared' });
  } catch (error) {
    logger.error(`Revenue target clearOverride failed: ${error.message}`, 'revenue-target');
    Sentry.captureException(error, { tags: { module: 'revenue-target' } });
    res.status(500).json({ error: 'Failed to clear override' });
  }
}

module.exports = {
  getConfig,
  updateConfig,
  getProgress,
  getHistory,
  getStats,
  getDecisions,
  setOverride,
  clearOverride,
};
