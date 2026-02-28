'use strict';

const logger = require('../../utils/logger');

const RISK_CAP_MIN = 0.80;
const RISK_CAP_MAX = 1.05;

/**
 * Compute risk multiplier from HV percentile.
 * Deterministic, capped to prevent over-leverage.
 *
 * Rules:
 *   hvPercentile > 0.85   → 0.80  (reduce risk in extreme vol)
 *   0.60 – 0.85           → 0.90
 *   0.40 – 0.60           → 1.00  (baseline)
 *   0.30 – 0.40           → 1.00
 *   < 0.30                → 1.05  (slightly increased in calm markets)
 *
 * @param {number|null} hvPercentile
 * @returns {number} Capped multiplier in [0.80, 1.05]
 */
function computeRiskMultiplier(hvPercentile) {
  if (typeof hvPercentile !== 'number' || isNaN(hvPercentile)) return 1.0;

  let multiplier;
  if (hvPercentile > 0.85) {
    multiplier = 0.80;
  } else if (hvPercentile >= 0.60) {
    multiplier = 0.90;
  } else if (hvPercentile >= 0.40) {
    multiplier = 1.0;
  } else if (hvPercentile < 0.30) {
    multiplier = 1.05;
  } else {
    multiplier = 1.0;
  }

  return Math.max(RISK_CAP_MIN, Math.min(RISK_CAP_MAX, multiplier));
}

/**
 * Apply risk scaling to a base risk value.
 *
 * @param {number} baseRisk
 * @param {number|null} hvPercentile
 * @returns {{ adjustedRisk: number, multiplier: number }}
 */
function applyRiskScaling(baseRisk, hvPercentile) {
  const multiplier = computeRiskMultiplier(hvPercentile);
  const adjustedRisk = baseRisk * multiplier;

  if (multiplier !== 1.0) {
    logger.info(
      `[RISK_SCALE] hvPct=${typeof hvPercentile === 'number' ? (hvPercentile * 100).toFixed(0) + '%' : 'N/A'} ` +
      `multiplier=${multiplier} base=${baseRisk.toFixed(2)} adjusted=${adjustedRisk.toFixed(2)}`,
      'risk-scaler'
    );
  }

  return { adjustedRisk, multiplier };
}

module.exports = { computeRiskMultiplier, applyRiskScaling, RISK_CAP_MIN, RISK_CAP_MAX };
