'use strict';

const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');
const backtestService = require('./backtest.service');

/**
 * POST /api/sim/backtest
 * Start a webhook backtest run.
 */
async function startBacktest(req, res) {
  try {
    const { startDate, endDate, indicatorSources, strategies, config } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({
        error: 'Missing required fields: startDate, endDate',
      });
    }

    const run = await backtestService.startBacktest(req.user.id, {
      startDate,
      endDate,
      indicatorSources: Array.isArray(indicatorSources) ? indicatorSources : null,
      strategies: Array.isArray(strategies) ? strategies : null,
      config: config || {},
    });

    res.status(202).json({
      message: 'Backtest started',
      run: {
        id: run.id,
        start_date: run.start_date,
        end_date: run.end_date,
        status: run.status,
        created_at: run.created_at,
      },
    });
  } catch (error) {
    logger.error(`Start backtest failed: ${error.message}`, 'backtest');
    Sentry.captureException(error, { tags: { module: 'backtest-controller' } });
    res.status(500).json({ error: error.message });
  }
}

/**
 * GET /api/sim/backtest/:id
 * Get backtest run status and results.
 */
async function getBacktest(req, res) {
  try {
    const run = await backtestService.getRun(req.params.id, req.user.id);
    if (!run) {
      return res.status(404).json({ error: 'Backtest run not found' });
    }
    res.json(run);
  } catch (error) {
    logger.error(`Get backtest failed: ${error.message}`, 'backtest');
    Sentry.captureException(error, { tags: { module: 'backtest-controller' } });
    res.status(500).json({ error: error.message });
  }
}

/**
 * GET /api/sim/backtest
 * List user's backtest runs.
 */
async function listBacktests(req, res) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const result = await backtestService.listRuns(req.user.id, { page, limit });
    res.json(result);
  } catch (error) {
    logger.error(`List backtests failed: ${error.message}`, 'backtest');
    Sentry.captureException(error, { tags: { module: 'backtest-controller' } });
    res.status(500).json({ error: error.message });
  }
}

/**
 * POST /api/sim/backtest/preflight
 * Check how many webhooks match the given filters (before running).
 */
async function preflightBacktest(req, res) {
  try {
    const { startDate, endDate, indicatorSources, strategies } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Missing required fields: startDate, endDate' });
    }
    const webhookService = require('../webhooks/webhook.service');
    const count = await webhookService.getCountByDateRange(req.user.id, startDate, endDate, {
      indicatorSources: Array.isArray(indicatorSources) ? indicatorSources : null,
      strategies: Array.isArray(strategies) ? strategies : null,
    });
    res.json({ count });
  } catch (error) {
    logger.error(`Backtest preflight failed: ${error.message}`, 'backtest');
    Sentry.captureException(error, { tags: { module: 'backtest-controller' } });
    res.status(500).json({ error: error.message });
  }
}

/**
 * GET /api/sim/strategies
 * List available strategies for backtest filter.
 */
async function getStrategies(req, res) {
  try {
    const strategies = await backtestService.getStrategies(req.user.id);
    res.json({ strategies });
  } catch (error) {
    logger.error(`Get strategies failed: ${error.message}`, 'backtest');
    Sentry.captureException(error, { tags: { module: 'backtest-controller' } });
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  startBacktest,
  getBacktest,
  listBacktests,
  getStrategies,
  preflightBacktest,
};
