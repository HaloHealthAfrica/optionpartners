'use strict';

const revenueTargetConfig = require('./revenue-target-config.service');

/** LEAP threshold: DTE >= 365 days */
const LEAP_DTE_THRESHOLD = 365;

/**
 * Check if a trade type is allowed by revenue target config.
 * Only CREDIT_SPREAD, DEBIT_SPREAD, and LEAP (CALL/PUT with DTE >= 365) pass when configured.
 *
 * @param {string} userId
 * @param {string} contractType - CREDIT_SPREAD, DEBIT_SPREAD, CALL, PUT, STOCK
 * @param {number} [dte] - Days to expiration (for LEAP check)
 * @returns {Promise<{ allowed: boolean, reason?: string, tradeType?: string }>}
 */
async function isTradeTypeAllowed(userId, contractType, dte = null) {
  const config = await revenueTargetConfig.getConfig(userId);
  if (!config.enabled) {
    return { allowed: true, reason: 'Revenue target disabled', tradeType: contractType };
  }

  const allowed = config.allowedTradeTypes || ['CREDIT_SPREAD', 'DEBIT_SPREAD', 'LEAP'];
  const allowedSet = new Set(allowed.map((t) => (t || '').toUpperCase()));

  const ct = (contractType || '').toUpperCase();

  if (ct === 'CREDIT_SPREAD' && allowedSet.has('CREDIT_SPREAD')) {
    return { allowed: true, reason: 'Credit spread allowed', tradeType: 'CREDIT_SPREAD' };
  }

  if (ct === 'DEBIT_SPREAD' && allowedSet.has('DEBIT_SPREAD')) {
    return { allowed: true, reason: 'Debit spread allowed', tradeType: 'DEBIT_SPREAD' };
  }

  const effectiveDte = typeof dte === 'number' ? dte : (dte != null ? parseFloat(dte) : null);
  if ((ct === 'CALL' || ct === 'PUT') && allowedSet.has('LEAP') && effectiveDte != null && effectiveDte >= LEAP_DTE_THRESHOLD) {
    return { allowed: true, reason: 'LEAP allowed (DTE >= 365)', tradeType: 'LEAP' };
  }

  // Single-leg CALL/PUT (e.g. CRT, swing options) when explicitly allowed
  if (ct === 'CALL' && allowedSet.has('CALL')) {
    return { allowed: true, reason: 'CALL allowed', tradeType: 'CALL' };
  }
  if (ct === 'PUT' && allowedSet.has('PUT')) {
    return { allowed: true, reason: 'PUT allowed', tradeType: 'PUT' };
  }

  const tradeTypeLabel = ct === 'CALL' || ct === 'PUT'
    ? (effectiveDte != null && effectiveDte >= LEAP_DTE_THRESHOLD ? 'LEAP' : `${ct} (short-term)`)
    : ct || 'UNKNOWN';

  return {
    allowed: false,
    reason: `Trade type "${tradeTypeLabel}" not allowed. Revenue target permits only: ${Array.from(allowedSet).join(', ')}`,
    tradeType: tradeTypeLabel,
  };
}

module.exports = {
  isTradeTypeAllowed,
  LEAP_DTE_THRESHOLD,
};
