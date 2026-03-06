'use strict';

const logger = require('../../utils/logger');

/**
 * Validate that volatility supports the expected option expansion
 * before approving a trade.
 *
 * The expected move is calibrated to the option's DTE using the
 * square-root-of-time rule: ATR14 is a daily measure, so the expected
 * move over N days scales by sqrt(N / 14). A configurable multiplier
 * (default 1.2) provides a conservative buffer.
 *
 *   expectedMove           = atr14 × multiplier × sqrt(dte / 14)
 *   expectedOptionExpansion = |delta| × expectedMove × 100
 *                          + 0.5 × gamma × expectedMove^2 × 100  (gamma convexity)
 *
 * Reject if: expectedOptionExpansion < (targetPctMove × optionPremium × 100)
 *
 * @param {Object} params
 * @param {number} params.atr14          - 14-day ATR of the underlying
 * @param {number} params.delta          - Option delta (absolute value used)
 * @param {number} params.optionPremium  - Option mid price (per share)
 * @param {number} [params.targetPctMove=0.50] - Target gain as decimal (50%)
 * @param {number} [params.dte]          - Days to expiration for time scaling
 * @param {number} [params.gamma]        - Option gamma for convexity term
 * @returns {{ pass: boolean, reason?: string, details: Object }}
 */
function validateExpectedMove({ atr14, delta, optionPremium, targetPctMove, dte, gamma }) {
  const defaultTarget = parseFloat(process.env.SIM_EM_TARGET_PCT || '0.30');
  targetPctMove = targetPctMove ?? defaultTarget;
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
  const multiplier = parseFloat(process.env.SIM_EM_MULTIPLIER || '1.2');

  // Scale ATR14 to the holding period using sqrt-of-time rule.
  // ATR14 approximates the average daily range over 14 days; dividing by
  // sqrt(14) normalises to a single day, then multiplying by sqrt(dte)
  // projects to the holding period.
  const effectiveDte = (typeof dte === 'number' && dte > 0) ? dte : 14;
  const timeScaling = Math.sqrt(effectiveDte / 14);
  const expectedMove = atr14 * multiplier * timeScaling;

  // First-order approximation: delta × move × 100
  let expectedOptionExpansion = absDelta * expectedMove * 100;

  // Second-order gamma convexity: for larger moves, gamma adds to the P&L.
  // 0.5 × gamma × move^2 × 100  (per-contract dollars)
  if (typeof gamma === 'number' && gamma > 0) {
    const gammaContribution = 0.5 * gamma * expectedMove * expectedMove * 100;
    expectedOptionExpansion += gammaContribution;
  }

  const requiredExpansion = targetPctMove * optionPremium * 100;

  const details = {
    atr14,
    expectedMove: Math.round(expectedMove * 100) / 100,
    delta: absDelta,
    gamma: gamma ?? null,
    dte: effectiveDte,
    timeScaling: Math.round(timeScaling * 1000) / 1000,
    multiplier,
    expectedOptionExpansion: Math.round(expectedOptionExpansion * 100) / 100,
    requiredExpansion: Math.round(requiredExpansion * 100) / 100,
    optionPremium,
    targetPctMove,
  };

  if (expectedOptionExpansion < requiredExpansion) {
    const reason =
      `Expected option expansion $${details.expectedOptionExpansion.toFixed(2)} < ` +
      `required $${details.requiredExpansion.toFixed(2)} ` +
      `(${(targetPctMove * 100).toFixed(0)}% of $${optionPremium} premium, ` +
      `DTE=${effectiveDte}, ATR scaling=${timeScaling.toFixed(2)}x)`;
    logger.info(`[EXPECTED_MOVE_REJECT] ${reason}`, 'expected-move-filter');
    return { pass: false, reason, details };
  }

  return { pass: true, details };
}

module.exports = { validateExpectedMove };
