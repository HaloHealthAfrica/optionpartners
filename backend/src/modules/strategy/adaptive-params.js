'use strict';

const logger = require('../../utils/logger');

/**
 * Compute adaptive strategy parameters based on regime metrics.
 * All adjustments are formula-based and deterministic.
 *
 * HV Percentile rules:
 *   >= 0.75 → reduce DTE 5-10d, delta +0.03, TP -5%
 *   <= 0.30 → increase DTE +10d, delta → 0.45-0.50, tighten spread
 *
 * ATR ratio rule:
 *   atr14 > atr30 → allow slightly lower delta for explosive engine
 *
 * @param {Object} baseConfig - Strike/DTE/delta config from trade decision engine
 * @param {Object|null} regimeMetrics - { hvPercentile252, atr14, atr30 }
 * @returns {Object} Adjusted config with logged adjustments
 */
function getAdaptiveStrategyParams(baseConfig, regimeMetrics) {
  if (!regimeMetrics) {
    return { ...baseConfig, adaptationApplied: false, adjustments: [] };
  }

  const { hvPercentile252, atr14, atr30 } = regimeMetrics;
  const adjustments = [];
  const result = { ...baseConfig };

  if (typeof hvPercentile252 !== 'number') {
    return { ...baseConfig, adaptationApplied: false, adjustments: [] };
  }

  if (hvPercentile252 >= 0.75) {
    const dteDelta = Math.min(10, Math.max(5, Math.round(hvPercentile252 * 12)));
    result.dte_target = Math.max(result.dte_min || 7, (result.dte_target || 21) - dteDelta);
    result.delta_target = Math.min(0.70, (result.delta_target || 0.50) + 0.03);
    result.takeProfitReduction = 0.05;
    adjustments.push(
      `HV_HIGH(${(hvPercentile252 * 100).toFixed(0)}%): DTE-${dteDelta}, delta+0.03, TP-5%`
    );
  }

  if (hvPercentile252 <= 0.30) {
    result.dte_target = Math.min(result.dte_max || 45, (result.dte_target || 21) + 10);
    result.delta_target = Math.min(0.50, Math.max(0.45, result.delta_target || 0.50));
    result.max_bid_ask_spread_pct = Math.max(0.03, (result.max_bid_ask_spread_pct || 0.08) - 0.02);
    adjustments.push(
      `HV_LOW(${(hvPercentile252 * 100).toFixed(0)}%): DTE+10, delta→0.45-0.50, spread tightened`
    );
  }

  if (typeof atr14 === 'number' && typeof atr30 === 'number' && atr30 > 0 && atr14 > atr30) {
    const atrRatio = atr14 / atr30;
    result.min_delta = Math.max(0.35, (result.min_delta || 0.45) - 0.05);
    adjustments.push(
      `ATR_EXPANDING(${atrRatio.toFixed(2)}): min_delta lowered for explosive engine`
    );
  }

  result.adaptationApplied = adjustments.length > 0;
  result.adjustments = adjustments;

  if (adjustments.length > 0) {
    logger.info(
      `[ADAPTIVE_PARAMS] ${adjustments.join(' | ')}`,
      'adaptive-params'
    );
  }

  return result;
}

module.exports = { getAdaptiveStrategyParams };
