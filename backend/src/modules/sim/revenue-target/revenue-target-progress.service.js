'use strict';

const db = require('../../../config/database');
const logger = require('../../../utils/logger');
const { getETDate } = require('../../../utils/timezone');

/**
 * Get today's realized PnL and trade count for a user.
 * Uses sim_account_state.daily_pnl (ET date) and counts filled BUY orders today.
 * @param {string} userId
 * @returns {Promise<{ realizedToday: number, tradesCountToday: number, tradeDate: string }>}
 */
async function getTodayProgress(userId) {
  const dateStr = getETDate();

  const [accountResult, tradesResult] = await Promise.all([
    db.query(
      `SELECT daily_pnl, daily_pnl_reset_at
       FROM sim_account_state
       WHERE user_id = $1`,
      [userId]
    ),
    db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM sim_orders o
       WHERE o.user_id = $1
         AND o.side = 'BUY'
         AND o.status = 'FILLED'
         AND (o.created_at AT TIME ZONE 'America/New_York')::date = $2::date`,
      [userId, dateStr]
    ),
  ]);

  const account = accountResult.rows[0];
  const realizedToday = account
    ? parseFloat(account.daily_pnl || 0)
    : 0;
  const tradesCountToday = tradesResult.rows[0]?.cnt ?? 0;

  return {
    realizedToday,
    tradesCountToday,
    tradeDate: dateStr,
  };
}

/**
 * Record or update daily progress snapshot for analytics.
 * @param {string} userId
 * @param {number} target
 * @param {number} [realized]
 * @param {number} [tradesCount]
 */
async function recordDailySnapshot(userId, target, realized = null, tradesCount = null) {
  const tradeDate = getETDate();
  const progress = await getTodayProgress(userId);
  const finalRealized = realized ?? progress.realizedToday;
  const finalTradesCount = tradesCount ?? progress.tradesCountToday;

  let status = 'pending';
  if (finalRealized >= target) status = 'met';
  else if (finalRealized > 0) status = finalRealized >= target * 0.5 ? 'on_track' : 'behind';
  else if (finalTradesCount > 0) status = 'behind';

  await db.query(
    `INSERT INTO revenue_target_daily (user_id, trade_date, target, realized, trades_count, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id, trade_date) DO UPDATE SET
       realized = EXCLUDED.realized,
       trades_count = EXCLUDED.trades_count,
       status = EXCLUDED.status,
       updated_at = NOW()`,
    [userId, tradeDate, target, finalRealized, finalTradesCount, status]
  );
}

/**
 * Get recent daily progress for dashboard (last N days).
 * @param {string} userId
 * @param {number} days
 * @returns {Promise<Array<{ tradeDate, target, realized, tradesCount, status }>>}
 */
async function getRecentProgress(userId, days = 14) {
  const { rows } = await db.query(
    `SELECT trade_date, target, realized, trades_count, status, override_used
     FROM revenue_target_daily
     WHERE user_id = $1
     ORDER BY trade_date DESC
     LIMIT $2`,
    [userId, days]
  );
  return rows.map((r) => ({
    tradeDate: r.trade_date,
    target: parseFloat(r.target),
    realized: parseFloat(r.realized),
    tradesCount: r.trades_count,
    status: r.status,
    overrideUsed: r.override_used ?? false,
  }));
}

/**
 * Get rolling stats: days on track, days behind, average realized.
 * @param {string} userId
 * @param {number} days
 * @returns {Promise<Object>}
 */
async function getRollingStats(userId, days = 14) {
  const recent = await getRecentProgress(userId, days);
  const met = recent.filter((r) => r.status === 'met').length;
  const onTrack = recent.filter((r) => r.status === 'on_track').length;
  const behind = recent.filter((r) => r.status === 'behind').length;
  const totalRealized = recent.reduce((s, r) => s + r.realized, 0);
  const avgRealized = recent.length > 0 ? totalRealized / recent.length : 0;

  return {
    daysMet: met,
    daysOnTrack: onTrack,
    daysBehind: behind,
    totalDays: recent.length,
    totalRealized,
    avgRealizedPerDay: Math.round(avgRealized * 100) / 100,
  };
}

/**
 * Mark override as used for today (when user activates override gate).
 * @param {string} userId
 */
async function recordOverrideUsed(userId) {
  const tradeDate = getETDate();
  const { rows } = await db.query(
    'SELECT target FROM revenue_target_config WHERE user_id = $1',
    [userId]
  );
  const target = rows[0] ? parseFloat(rows[0].target) : 250;
  const progress = await getTodayProgress(userId);
  await db.query(
    `INSERT INTO revenue_target_daily (user_id, trade_date, target, realized, trades_count, status, override_used, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
     ON CONFLICT (user_id, trade_date) DO UPDATE SET override_used = TRUE, updated_at = NOW()`,
    [userId, tradeDate, target, progress.realizedToday, progress.tradesCountToday, 'pending']
  );
}

module.exports = {
  getTodayProgress,
  recordDailySnapshot,
  getRecentProgress,
  getRollingStats,
  recordOverrideUsed,
};
