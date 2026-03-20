'use strict';

const db = require('../../../config/database');
const logger = require('../../../utils/logger');

const DEFAULTS = {
  daily_target: 250,
  target_mode: 'daily',
  max_trades_per_day: 3,
  min_credit_per_trade: 50,
  aggression_mode: 'balanced',
  enabled: true,
  exempt_close_legs: true,
  scale_back_1_pct: 80,
  scale_back_2_pct: 50,
  aggressive_max: 1.25,
  aggressive_cap: 1.5,
  allowed_trade_types: ['CREDIT_SPREAD', 'DEBIT_SPREAD', 'LEAP', 'CALL', 'PUT'],
};

/**
 * Validate and sanitize configuration values
 * @param {Object} config
 * @returns {Object} Sanitized config
 */
function validateAndSanitizeConfig(config) {
  const sanitized = { ...DEFAULTS };

  // Validate daily_target (0-5000 range, must be positive or zero)
  if (typeof config.daily_target === 'number' && config.daily_target >= 0 && config.daily_target <= 5000) {
    sanitized.daily_target = Math.round(config.daily_target * 100) / 100; // Round to cents
  }

  // Validate target_mode
  if (['daily', 'weekly', 'monthly'].includes(config.target_mode)) {
    sanitized.target_mode = config.target_mode;
  }

  // Validate max_trades_per_day (1-50 range)
  if (typeof config.max_trades_per_day === 'number' && config.max_trades_per_day >= 1 && config.max_trades_per_day <= 50) {
    sanitized.max_trades_per_day = Math.floor(config.max_trades_per_day);
  }

  // Validate min_credit_per_trade (0-1000 range)
  if (typeof config.min_credit_per_trade === 'number' && config.min_credit_per_trade >= 0 && config.min_credit_per_trade <= 1000) {
    sanitized.min_credit_per_trade = Math.round(config.min_credit_per_trade * 100) / 100; // Round to cents
  }

  // Validate aggression_mode
  if (['conservative', 'balanced', 'aggressive'].includes(config.aggression_mode)) {
    sanitized.aggression_mode = config.aggression_mode;
  }

  // Validate enabled (boolean)
  if (typeof config.enabled === 'boolean') {
    sanitized.enabled = config.enabled;
  }

  // Sizer thresholds (accept snake_case or camelCase)
  const exempt = config.exempt_close_legs ?? config.exemptCloseLegs;
  if (typeof exempt === 'boolean') sanitized.exempt_close_legs = exempt;
  const s1 = config.scale_back_1_pct ?? config.scaleBack1Pct;
  if (typeof s1 === 'number' && s1 >= 0 && s1 <= 100) sanitized.scale_back_1_pct = s1;
  const s2 = config.scale_back_2_pct ?? config.scaleBack2Pct;
  if (typeof s2 === 'number' && s2 >= 0 && s2 <= 100) sanitized.scale_back_2_pct = s2;
  const am = config.aggressive_max ?? config.aggressiveMax;
  if (typeof am === 'number' && am >= 1 && am <= 2) sanitized.aggressive_max = am;
  const ac = config.aggressive_cap ?? config.aggressiveCap;
  if (typeof ac === 'number' && ac >= 1 && ac <= 2) sanitized.aggressive_cap = ac;

  const att = config.allowed_trade_types ?? config.allowedTradeTypes;
  if (Array.isArray(att) && att.length > 0) {
    const valid = ['CREDIT_SPREAD', 'DEBIT_SPREAD', 'LEAP', 'CALL', 'PUT'];
    sanitized.allowed_trade_types = att
      .map((t) => (t || '').toUpperCase())
      .filter((t) => valid.includes(t));
    if (sanitized.allowed_trade_types.length === 0) {
      sanitized.allowed_trade_types = DEFAULTS.allowed_trade_types;
    }
  }

  return sanitized;
}

/**
 * Get revenue target config for a user. Creates default if none exists.
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function getConfig(userId) {
  const { rows } = await db.query(
    'SELECT * FROM revenue_target_config WHERE user_id = $1',
    [userId]
  );
  if (rows.length > 0) {
    return _rowToConfig(rows[0]);
  }
  await upsertConfig(userId, DEFAULTS);
  return getConfig(userId);
}

/**
 * Upsert revenue target config.
 * @param {string} userId
 * @param {Object} config - { daily_target, target_mode, max_trades_per_day, min_credit_per_trade, aggression_mode, enabled }
 * @returns {Promise<Object>}
 */
async function upsertConfig(userId, config = {}) {
  // Validate and sanitize input
  const validatedConfig = validateAndSanitizeConfig(config);

  const daily_target = validatedConfig.daily_target;
  const target_mode = validatedConfig.target_mode;
  const max_trades_per_day = validatedConfig.max_trades_per_day;
  const min_credit_per_trade = validatedConfig.min_credit_per_trade;
  const aggression_mode = validatedConfig.aggression_mode;
  const enabled = validatedConfig.enabled;
  const exempt_close_legs = validatedConfig.exempt_close_legs ?? true;
  const scale_back_1_pct = validatedConfig.scale_back_1_pct ?? 80;
  const scale_back_2_pct = validatedConfig.scale_back_2_pct ?? 50;
  const aggressive_max = validatedConfig.aggressive_max ?? 1.25;
  const aggressive_cap = validatedConfig.aggressive_cap ?? 1.5;
  const allowed_trade_types = validatedConfig.allowed_trade_types ?? DEFAULTS.allowed_trade_types;

  await db.query(
    `INSERT INTO revenue_target_config
       (user_id, daily_target, target_mode, max_trades_per_day, min_credit_per_trade, aggression_mode, enabled,
        exempt_close_legs, scale_back_1_pct, scale_back_2_pct, aggressive_max, aggressive_cap, allowed_trade_types, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       daily_target = EXCLUDED.daily_target,
       target_mode = EXCLUDED.target_mode,
       max_trades_per_day = EXCLUDED.max_trades_per_day,
       min_credit_per_trade = EXCLUDED.min_credit_per_trade,
       aggression_mode = EXCLUDED.aggression_mode,
       enabled = EXCLUDED.enabled,
       exempt_close_legs = EXCLUDED.exempt_close_legs,
       scale_back_1_pct = EXCLUDED.scale_back_1_pct,
       scale_back_2_pct = EXCLUDED.scale_back_2_pct,
       aggressive_max = EXCLUDED.aggressive_max,
       aggressive_cap = EXCLUDED.aggressive_cap,
       allowed_trade_types = EXCLUDED.allowed_trade_types,
       updated_at = NOW()`,
    [userId, daily_target, target_mode, max_trades_per_day, min_credit_per_trade, aggression_mode, enabled,
      exempt_close_legs, scale_back_1_pct, scale_back_2_pct, aggressive_max, aggressive_cap, allowed_trade_types]
  );

  logger.info(
    `[REVENUE_TARGET] Config updated for user ${userId}: target=$${daily_target}/day max_trades=${max_trades_per_day} enabled=${enabled}`,
    'revenue-target-config'
  );
  return getConfig(userId);
}

/**
 * Check if revenue target module is enabled for user.
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isEnabled(userId) {
  try {
    const config = await getConfig(userId);
    return !!config.enabled;
  } catch {
    return false;
  }
}

function _rowToConfig(row) {
  const att = row.allowed_trade_types;
  return {
    userId: row.user_id,
    dailyTarget: parseFloat(row.daily_target),
    targetMode: row.target_mode,
    maxTradesPerDay: row.max_trades_per_day,
    minCreditPerTrade: parseFloat(row.min_credit_per_trade),
    aggressionMode: row.aggression_mode,
    enabled: row.enabled,
    exemptCloseLegs: row.exempt_close_legs ?? true,
    scaleBack1Pct: row.scale_back_1_pct != null ? parseFloat(row.scale_back_1_pct) : 80,
    scaleBack2Pct: row.scale_back_2_pct != null ? parseFloat(row.scale_back_2_pct) : 50,
    aggressiveMax: row.aggressive_max != null ? parseFloat(row.aggressive_max) : 1.25,
    aggressiveCap: row.aggressive_cap != null ? parseFloat(row.aggressive_cap) : 1.5,
    allowedTradeTypes: Array.isArray(att) ? att : (att ? [att] : ['CREDIT_SPREAD', 'DEBIT_SPREAD', 'LEAP']),
    overrideGateUntil: row.override_gate_until,
    updatedAt: row.updated_at,
  };
}

/**
 * Set override gate until timestamp (allows trades past limit until this time).
 * @param {string} userId
 * @param {Date|string|null} until - ISO string or Date; null to clear
 * @returns {Promise<Object>}
 */
async function setOverrideGateUntil(userId, until) {
  const ts = until ? new Date(until).toISOString() : null;
  await db.query(
    'UPDATE revenue_target_config SET override_gate_until = $2, updated_at = NOW() WHERE user_id = $1',
    [userId, ts]
  );
  return getConfig(userId);
}

module.exports = {
  getConfig,
  upsertConfig,
  isEnabled,
  setOverrideGateUntil,
  DEFAULTS,
};
