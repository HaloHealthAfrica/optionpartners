'use strict';

const db = require('../../../config/database');

/**
 * Log a revenue target decision for audit trail.
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} [params.symbol]
 * @param {string} [params.action] - OPEN, CLOSE
 * @param {string} [params.instrumentDesc] - e.g. "SPY 515C", "QQQ 430P"
 * @param {string} params.decision - ALLOWED, BLOCKED
 * @param {string} [params.reason]
 * @param {number} [params.sizeMultiplier]
 * @param {string} [params.tradeId]
 * @param {string} [params.webhookEventId]
 * @param {string} [params.tradeType] - CREDIT_SPREAD, DEBIT_SPREAD, LEAP, etc.
 */
async function logDecision(params) {
  const {
    userId,
    symbol,
    action,
    instrumentDesc,
    decision,
    reason,
    sizeMultiplier,
    tradeId,
    webhookEventId,
    tradeType,
  } = params;

  try {
    await db.query(
      `INSERT INTO revenue_target_decisions
         (user_id, symbol, action, instrument_desc, decision, reason, size_multiplier, trade_id, webhook_event_id, trade_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        symbol || null,
        action || null,
        instrumentDesc || null,
        decision,
        reason || null,
        sizeMultiplier ?? null,
        tradeId || null,
        webhookEventId || null,
        tradeType || null,
      ]
    );
  } catch (err) {
    // Don't fail the pipeline if logging fails
    const logger = require('../../../utils/logger');
    logger.error(`[REVENUE_TARGET] Decision log failed: ${err.message}`, 'revenue-target');
  }
}

/**
 * Get recent decisions for a user.
 * @param {string} userId
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function getRecentDecisions(userId, limit = 50) {
  const { rows } = await db.query(
    `SELECT rtd.*, st.id as sim_trade_id,
            we.indicator_source as webhook_source,
            we.raw_payload->>'signal_type' as signal_type,
            we.raw_payload->>'signal' as signal
     FROM revenue_target_decisions rtd
     LEFT JOIN sim_trades st ON st.webhook_event_id = rtd.webhook_event_id AND st.user_id = rtd.user_id
     LEFT JOIN webhook_events we ON we.id = rtd.webhook_event_id
     WHERE rtd.user_id = $1
     ORDER BY rtd.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );

  return rows.map((r) => {
    const source = r.webhook_source || null;
    const detail = r.signal_type || r.signal || null;
    const webhookSource = source ? (detail ? `${source} ${detail}` : source) : null;
    return {
      id: r.id,
      createdAt: r.created_at,
      symbol: r.symbol,
      action: r.action,
      instrumentDesc: r.instrument_desc,
      decision: r.decision,
      reason: r.reason,
      sizeMultiplier: r.size_multiplier != null ? parseFloat(r.size_multiplier) : null,
      tradeId: r.sim_trade_id,
      webhookEventId: r.webhook_event_id,
      tradeType: r.trade_type,
      webhookSource,
    };
  });
}

module.exports = {
  logDecision,
  getRecentDecisions,
};
