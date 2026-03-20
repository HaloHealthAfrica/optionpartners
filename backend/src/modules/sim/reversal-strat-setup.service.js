'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');

/** Setup TTL: 24 hours — strat setups typically trigger within minutes to hours */
const SETUP_TTL_HOURS = parseInt(process.env.REVERSAL_STRAT_SETUP_TTL_HOURS || '24', 10);

/**
 * Store a Reversal STRAT_SETUP for later STRAT_TRIGGER matching.
 * @param {string} setupId - Unique setup ID (e.g. SPY-5-1741456200000)
 * @param {string} userId
 * @param {Object} payload - Full STRAT_SETUP payload
 * @returns {Promise<Object>} Stored setup row
 */
async function storeSetup(setupId, userId, payload) {
  const symbol = (payload.symbol || '').toUpperCase();
  if (!symbol) throw new Error('Missing symbol in STRAT_SETUP');

  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + SETUP_TTL_HOURS);

  const result = await db.query(
    `INSERT INTO reversal_strat_setups
       (setup_id, user_id, symbol, pattern, timeframe, trigger_level, setup_low, expects_trigger, raw_payload, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (setup_id, user_id) DO UPDATE SET
       pattern = EXCLUDED.pattern,
       timeframe = EXCLUDED.timeframe,
       trigger_level = EXCLUDED.trigger_level,
       setup_low = EXCLUDED.setup_low,
       expects_trigger = EXCLUDED.expects_trigger,
       raw_payload = EXCLUDED.raw_payload,
       expires_at = EXCLUDED.expires_at
     RETURNING *`,
    [
      setupId,
      userId,
      symbol,
      payload.pattern || null,
      payload.timeframe || null,
      parseFloat(payload.trigger_level) || null,
      parseFloat(payload.setup_low) || null,
      payload.expects_trigger !== false,
      JSON.stringify(payload),
      expiresAt,
    ]
  );

  logger.info(`[REVERSAL] Stored STRAT_SETUP ${setupId} for ${symbol}`, 'reversal-strat-setup');
  return result.rows[0];
}

/**
 * Get a stored setup by setup_id and user. Returns null if not found or expired.
 * @param {string} setupId
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getSetup(setupId, userId) {
  const result = await db.query(
    `SELECT * FROM reversal_strat_setups
     WHERE setup_id = $1 AND user_id = $2
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [setupId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Remove a setup after it has been triggered (optional cleanup).
 * @param {string} setupId
 * @param {string} userId
 */
async function removeSetup(setupId, userId) {
  await db.query(
    'DELETE FROM reversal_strat_setups WHERE setup_id = $1 AND user_id = $2',
    [setupId, userId]
  );
}

module.exports = {
  storeSetup,
  getSetup,
  removeSetup,
};
