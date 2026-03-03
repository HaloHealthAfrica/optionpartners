'use strict';

const strategyScorecardService = require('./strategy-scorecard.service');
const adaptiveGuards = require('./adaptive-guards');
const marketIntelligence = require('./market-intelligence');
const exitMonitor = require('./exit-monitor');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');

/**
 * GET /api/sim/intelligence/scorecard
 */
async function getScorecard(req, res) {
  try {
    const scorecards = await strategyScorecardService.getAllScorecards(req.user.id);
    res.json(scorecards);
  } catch (error) {
    logger.error(`Get scorecard failed: ${error.message}`, 'intelligence');
    Sentry.captureException(error, { tags: { module: 'intelligence-controller' } });
    res.status(500).json({ error: 'Failed to get strategy scorecard' });
  }
}

/**
 * POST /api/sim/intelligence/scorecard/recalculate
 */
async function recalculateScorecard(req, res) {
  try {
    const results = await strategyScorecardService.recalculateAll(req.user.id);
    res.json({ recalculated: results.length, scorecards: results });
  } catch (error) {
    logger.error(`Recalculate scorecard failed: ${error.message}`, 'intelligence');
    Sentry.captureException(error, { tags: { module: 'intelligence-controller' } });
    res.status(500).json({ error: 'Failed to recalculate scorecard' });
  }
}

/**
 * GET /api/sim/intelligence/cooldowns
 */
async function getCooldowns(req, res) {
  try {
    const cooldowns = await adaptiveGuards.getActiveCooldowns(req.user.id);
    res.json(cooldowns);
  } catch (error) {
    logger.error(`Get cooldowns failed: ${error.message}`, 'intelligence');
    Sentry.captureException(error, { tags: { module: 'intelligence-controller' } });
    res.status(500).json({ error: 'Failed to get cooldowns' });
  }
}

/**
 * DELETE /api/sim/intelligence/cooldowns/:strategy
 */
async function clearCooldown(req, res) {
  try {
    await db.query(
      'DELETE FROM strategy_cooldowns WHERE user_id = $1 AND strategy = $2',
      [req.user.id, req.params.strategy]
    );
    res.json({ message: `Cooldown cleared for ${req.params.strategy}` });
  } catch (error) {
    logger.error(`Clear cooldown failed: ${error.message}`, 'intelligence');
    Sentry.captureException(error, { tags: { module: 'intelligence-controller' } });
    res.status(500).json({ error: 'Failed to clear cooldown' });
  }
}

/**
 * GET /api/sim/intelligence/rejections
 */
async function getRejections(req, res) {
  try {
    const { page = 1, limit = 50, gate, strategy } = req.query;
    const conditions = ['user_id = $1'];
    const params = [req.user.id];
    let idx = 2;

    if (gate) { conditions.push(`gate = $${idx++}`); params.push(gate); }
    if (strategy) { conditions.push(`strategy = $${idx++}`); params.push(strategy); }

    const where = conditions.join(' AND ');
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT * FROM signal_rejections WHERE ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
        [...params, parseInt(limit), offset]
      ),
      db.query(`SELECT COUNT(*) as total FROM signal_rejections WHERE ${where}`, params),
    ]);

    res.json({
      rejections: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (error) {
    logger.error(`Get rejections failed: ${error.message}`, 'intelligence');
    Sentry.captureException(error, { tags: { module: 'intelligence-controller' } });
    res.status(500).json({ error: 'Failed to get signal rejections' });
  }
}

/**
 * GET /api/sim/intelligence/positions
 * Live position monitor with stop/target levels
 */
async function getLivePositions(req, res) {
  try {
    const result = await db.query(
      `SELECT p.*,
              CASE WHEN p.expiration IS NOT NULL
                THEN CEIL(EXTRACT(EPOCH FROM (p.expiration::timestamp - NOW())) / 86400)
                ELSE NULL
              END as current_dte,
              CASE WHEN p.avg_price > 0 AND p.current_price IS NOT NULL
                THEN ROUND(((p.current_price - p.avg_price) / p.avg_price * 100)::numeric, 2)
                ELSE 0
              END as pnl_pct,
              EXTRACT(EPOCH FROM (NOW() - p.opened_at)) / 3600 as hours_open
       FROM sim_positions p
       WHERE p.user_id = $1 AND p.status = 'OPEN'
       ORDER BY p.opened_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    logger.error(`Get live positions failed: ${error.message}`, 'intelligence');
    Sentry.captureException(error, { tags: { module: 'intelligence-controller' } });
    res.status(500).json({ error: 'Failed to get live positions' });
  }
}

/**
 * GET /api/sim/intelligence/config
 */
async function getConfig(req, res) {
  try {
    let result = await db.query(
      'SELECT * FROM sim_intelligence_config WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      result = await db.query(
        `INSERT INTO sim_intelligence_config (user_id) VALUES ($1) RETURNING *`,
        [req.user.id]
      );
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error(`Get intelligence config failed: ${error.message}`, 'intelligence');
    Sentry.captureException(error, { tags: { module: 'intelligence-controller' } });
    res.status(500).json({ error: 'Failed to get intelligence config' });
  }
}

/**
 * PUT /api/sim/intelligence/config
 */
async function updateConfig(req, res) {
  try {
    const fields = [
      'min_win_rate', 'min_profit_factor', 'scorecard_window',
      'enable_signal_priority', 'enable_exit_monitor', 'exit_check_interval_ms',
      'default_trailing_stop_pct', 'default_max_hold_hours', 'force_close_at_dte_zero',
      'enable_strategy_cooldown', 'cooldown_consecutive_losses', 'cooldown_duration_minutes',
      'max_correlated_positions', 'enable_drawdown_throttle', 'drawdown_throttle_pct',
      'enable_options_constructor',
      // Market intelligence settings
      'enable_confluence', 'require_confluence', 'confluence_window_minutes', 'min_confluence_signals',
      'enable_flow_alignment', 'require_flow_alignment', 'flow_lookback_minutes', 'flow_min_premium',
      'enable_confidence_gate', 'min_signal_confidence',
      'enable_price_validation', 'require_price_validation', 'price_max_entry_slippage_pct',
      'min_intelligence_score',
    ];

    const updates = [];
    const params = [req.user.id];
    let idx = 2;

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${idx++}`);
        params.push(req.body[field]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = NOW()');

    await db.query(
      `INSERT INTO sim_intelligence_config (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [req.user.id]
    );

    const result = await db.query(
      `UPDATE sim_intelligence_config SET ${updates.join(', ')} WHERE user_id = $1 RETURNING *`,
      params
    );

    res.json(result.rows[0]);
  } catch (error) {
    logger.error(`Update intelligence config failed: ${error.message}`, 'intelligence');
    Sentry.captureException(error, { tags: { module: 'intelligence-controller' } });
    res.status(500).json({ error: 'Failed to update intelligence config' });
  }
}

/**
 * GET /api/sim/intelligence/status
 */
async function getIntelligenceStatus(req, res) {
  try {
    const [scorecards, cooldowns, config, exitStatus] = await Promise.all([
      strategyScorecardService.getAllScorecards(req.user.id),
      adaptiveGuards.getActiveCooldowns(req.user.id),
      db.query('SELECT * FROM sim_intelligence_config WHERE user_id = $1', [req.user.id]),
      Promise.resolve(exitMonitor.getStatus()),
    ]);

    const [rejectionsToday, verdictsToday] = await Promise.all([
      db.query(
        `SELECT gate, COUNT(*) as count FROM signal_rejections
         WHERE user_id = $1 AND created_at >= CURRENT_DATE
         GROUP BY gate`,
        [req.user.id]
      ),
      db.query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE allowed = TRUE) as approved,
           COUNT(*) FILTER (WHERE allowed = FALSE) as rejected,
           ROUND(AVG(intelligence_score)::numeric, 1) as avg_score,
           ROUND(AVG(intelligence_score) FILTER (WHERE allowed = TRUE)::numeric, 1) as avg_approved_score,
           COUNT(*) FILTER (WHERE flow_alignment = 'ALIGNED') as flow_aligned,
           COUNT(*) FILTER (WHERE flow_alignment = 'CONTRADICTED') as flow_contradicted,
           ROUND(AVG(confluence_count)::numeric, 1) as avg_confluence
         FROM intelligence_verdicts
         WHERE user_id = $1 AND created_at >= CURRENT_DATE`,
        [req.user.id]
      ),
    ]);

    res.json({
      scorecards,
      activeCooldowns: cooldowns,
      config: config.rows[0] || null,
      exitMonitor: exitStatus,
      rejectionsToday: rejectionsToday.rows,
      marketIntelligenceToday: verdictsToday.rows[0] || null,
      activeStrategies: scorecards.filter(s => s.status === 'ACTIVE').length,
      underperformingStrategies: scorecards.filter(s => s.status === 'UNDERPERFORMING').length,
    });
  } catch (error) {
    logger.error(`Get intelligence status failed: ${error.message}`, 'intelligence');
    Sentry.captureException(error, { tags: { module: 'intelligence-controller' } });
    res.status(500).json({ error: 'Failed to get intelligence status' });
  }
}

/**
 * GET /api/sim/intelligence/verdicts
 * Intelligence verdict history with filtering
 */
async function getVerdicts(req, res) {
  try {
    const { page = 1, limit = 50, symbol, allowed } = req.query;
    const conditions = ['user_id = $1'];
    const params = [req.user.id];
    let idx = 2;

    if (symbol) { conditions.push(`symbol = $${idx++}`); params.push(symbol.toUpperCase()); }
    if (allowed !== undefined) { conditions.push(`allowed = $${idx++}`); params.push(allowed === 'true'); }

    const where = conditions.join(' AND ');
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT * FROM intelligence_verdicts WHERE ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
        [...params, parseInt(limit), offset]
      ),
      db.query(`SELECT COUNT(*) as total FROM intelligence_verdicts WHERE ${where}`, params),
    ]);

    res.json({
      verdicts: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (error) {
    logger.error(`Get verdicts failed: ${error.message}`, 'intelligence');
    Sentry.captureException(error, { tags: { module: 'intelligence-controller' } });
    res.status(500).json({ error: 'Failed to get intelligence verdicts' });
  }
}

/**
 * GET /api/sim/intelligence/snapshot/:symbol
 * Real-time intelligence snapshot for a specific symbol
 */
async function getSymbolSnapshot(req, res) {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const snapshot = await marketIntelligence.getIntelligenceSnapshot(symbol, req.user.id);
    res.json(snapshot);
  } catch (error) {
    logger.error(`Get symbol snapshot failed: ${error.message}`, 'intelligence');
    Sentry.captureException(error, { tags: { module: 'intelligence-controller' } });
    res.status(500).json({ error: 'Failed to get symbol snapshot' });
  }
}

/**
 * GET /api/sim/intelligence/equity-by-strategy
 * Equity curve data broken down by strategy
 */
async function getEquityByStrategy(req, res) {
  try {
    const result = await db.query(
      `SELECT
        strategy,
        DATE(exit_time) as trade_date,
        SUM(pnl) as daily_pnl,
        SUM(SUM(pnl)) OVER (PARTITION BY strategy ORDER BY DATE(exit_time)) as cumulative_pnl
       FROM sim_trades
       WHERE user_id = $1 AND exit_time IS NOT NULL
       GROUP BY strategy, DATE(exit_time)
       ORDER BY strategy, trade_date`,
      [req.user.id]
    );

    const grouped = {};
    for (const row of result.rows) {
      if (!grouped[row.strategy]) grouped[row.strategy] = [];
      grouped[row.strategy].push({
        date: row.trade_date,
        dailyPnl: parseFloat(row.daily_pnl),
        cumulativePnl: parseFloat(row.cumulative_pnl),
      });
    }

    res.json(grouped);
  } catch (error) {
    logger.error(`Get equity by strategy failed: ${error.message}`, 'intelligence');
    Sentry.captureException(error, { tags: { module: 'intelligence-controller' } });
    res.status(500).json({ error: 'Failed to get equity by strategy' });
  }
}

module.exports = {
  getScorecard,
  recalculateScorecard,
  getCooldowns,
  clearCooldown,
  getRejections,
  getLivePositions,
  getConfig,
  updateConfig,
  getIntelligenceStatus,
  getEquityByStrategy,
  getVerdicts,
  getSymbolSnapshot,
};
