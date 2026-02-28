'use strict';

const logger = require('../../utils/logger');

/**
 * Validate that volatility supports the expected option expansion
 * before approving a trade.
 *
 *   expectedMove           = atr14 × 1.5
 *   expectedOptionExpansion = |delta| × expectedMove × 100
 *
 * Reject if: expectedOptionExpansion < (targetPctMove × optionPremium × 100)
 *
 * @param {Object} params
 * @param {number} params.atr14          - 14-day ATR of the underlying
 * @param {number} params.delta          - Option delta (absolute value used)
 * @param {number} params.optionPremium  - Option mid price (per share)
 * @param {number} [params.targetPctMove=0.50] - Target gain as decimal (50%)
 * @returns {{ pass: boolean, reason?: string, details: Object }}
 */
function validateExpectedMove({ atr14, delta, optionPremium, targetPctMove = 0.50 }) {
  if (typeof atr14 !== 'number' || atr14 <= 0) {
    return { pass: true, reason: 'ATR unavailable — skipping expected move filter', details: {} };
  }
  if (typeof delta !== 'number' || delta === 0) {
    return { pass: true, reason: 'Delta unavailable — skipping expected move filter', details: {} };
  }
  if (typeof optionPremium !== 'number' || optionPremium <= 0) {
    return { pass: true, reason: 'Premium unavailable — skipping expected move filter', details: {} };
  }

  const absDelta = Math.abs(delta);
  const expectedMove = atr14 * 1.5;
  const expectedOptionExpansion = absDelta * expectedMove * 100;
  const requiredExpansion = targetPctMove * optionPremium * 100;

  const details = {
    atr14,
    expectedMove: Math.round(expectedMove * 100) / 100,
    delta: absDelta,
    expectedOptionExpansion: Math.round(expectedOptionExpansion * 100) / 100,
    requiredExpansion: Math.round(requiredExpansion * 100) / 100,
    optionPremium,
    targetPctMove,
  };

  if (expectedOptionExpansion < requiredExpansion) {
    const reason =
      `Expected option expansion $${details.expectedOptionExpansion.toFixed(2)} < ` +
      `required $${details.requiredExpansion.toFixed(2)} ` +
      `(${(targetPctMove * 100).toFixed(0)}% of $${optionPremium} premium)`;
    logger.info(`[EXPECTED_MOVE_REJECT] ${reason}`, 'expected-move-filter');
    return { pass: false, reason, details };
  }

  return { pass: true, details };
}

module.exports = { validateExpectedMove };
