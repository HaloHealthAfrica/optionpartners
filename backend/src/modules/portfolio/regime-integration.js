'use strict';

const logger = require('../../utils/logger');

/**
 * Base portfolio configuration used when no regime data is available
 * or when regime is NEUTRAL.
 */
const BASE_PORTFOLIO_CONFIG = {
  explosiveAllocation: 0.30,
  compoundingAllocation: 0.70,
  riskMultiplier: 1.0,
  allowLowerDelta: false,
  tightenSpreadRequirement: false,
  extendMaxHoldDays: 0,
};

/**
 * Build adaptive portfolio configuration from regime data.
 * This layer only modifies config values — it never trades directly.
 *
 * Rules:
 *   HIGH_VOL_EXPANSION  → explosive 45%, compounding 55%, risk 0.9x, lower delta ok
 *   LOW_VOL_CHOP        → explosive 20%, compounding 80%, tighter spreads
 *   TRENDING            → explosive 35%, compounding 65%, extend hold +5d
 *   NEUTRAL / unknown   → base config
 *
 * @param {Object|null} regimeResult - Regime data from data service
 * @returns {Object} Adjusted portfolio config with regimeSource tag
 */
function getAdaptivePortfolioConfig(regimeResult) {
  if (!regimeResult?.regime) {
    return { ...BASE_PORTFOLIO_CONFIG, regimeSource: 'BASE_DEFAULT' };
  }

  const { regime } = regimeResult;
  let config;

  switch (regime) {
    case 'HIGH_VOL_EXPANSION':
      config = {
        explosiveAllocation: 0.45,
        compoundingAllocation: 0.55,
        riskMultiplier: 0.9,
        allowLowerDelta: true,
        tightenSpreadRequirement: false,
        extendMaxHoldDays: 0,
      };
      break;

    case 'LOW_VOL_CHOP':
      config = {
        explosiveAllocation: 0.20,
        compoundingAllocation: 0.80,
        riskMultiplier: 1.0,
        allowLowerDelta: false,
        tightenSpreadRequirement: true,
        extendMaxHoldDays: 0,
      };
      break;

    case 'TRENDING':
      config = {
        explosiveAllocation: 0.35,
        compoundingAllocation: 0.65,
        riskMultiplier: 1.0,
        allowLowerDelta: false,
        tightenSpreadRequirement: false,
        extendMaxHoldDays: 5,
      };
      break;

    default:
      config = { ...BASE_PORTFOLIO_CONFIG };
      break;
  }

  config.regimeSource = regime;

  logger.info(
    `[REGIME_PORTFOLIO] regime=${regime} explosive=${config.explosiveAllocation} ` +
    `compounding=${config.compoundingAllocation} riskMult=${config.riskMultiplier}`,
    'regime-integration'
  );

  return config;
}

module.exports = {
  getAdaptivePortfolioConfig,
  BASE_PORTFOLIO_CONFIG,
};
