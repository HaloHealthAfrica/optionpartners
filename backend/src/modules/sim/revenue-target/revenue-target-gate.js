'use strict';

const revenueTargetConfig = require('./revenue-target-config.service');
const revenueTargetProgress = require('./revenue-target-progress.service');
const logger = require('../../../utils/logger');
const dataServiceProxy = require('../../../services/dataServiceProxy');

/**
 * Check if external services are healthy
 * @returns {Promise<boolean>}
 */
async function areServicesHealthy() {
  try {
    // Quick health check - try to get a quote for a major symbol
    await dataServiceProxy.getQuote('SPY');
    return true;
  } catch (error) {
    logger.warn(`[REVENUE_TARGET] External services health check failed: ${error.message}`, 'revenue-target');
    return false;
  }
}

/**
 * Validate revenue target configuration for safety
 * @param {Object} config
 * @returns {boolean}
 */
function validateConfig(config) {
  if (!config) return false;

  // Basic validation
  if (config.dailyTarget < 0) return false;
  if (config.maxTradesPerDay < 1 || config.maxTradesPerDay > 50) return false;
  if (config.minCreditPerTrade < 0) return false;
  if (!['conservative', 'balanced', 'aggressive'].includes(config.aggressionMode)) return false;

  return true;
}

/**
 * Check whether new trades should be allowed today based on revenue target config.
 * Used before trade evaluation in the decision router.
 *
 * @param {string} userId
 * @param {Object} [options] - Additional context for decision making
 * @param {boolean} [options.allowFallback] - Allow fallback mode on errors
 * @param {boolean} [options.isCloseLeg] - True if this is a SELL/CLOSE order
 * @returns {Promise<{ allowed: boolean, reason?: string, remainingTarget?: number, tradesCountToday?: number, fallbackMode?: boolean }>}
 */
async function shouldAllowNewTrades(userId, options = {}) {
  try {
    const config = await revenueTargetConfig.getConfig(userId);
    if (!config.enabled) {
      return { allowed: true, reason: 'Revenue target disabled' };
    }

    // Close-leg exemption: SELL/CLOSE orders bypass the gate
    if (options.isCloseLeg && config.exemptCloseLegs) {
      return { allowed: true, reason: 'Exempt — close leg' };
    }

    // Session override: allow if override_gate_until is in the future
    if (config.overrideGateUntil) {
      const until = new Date(config.overrideGateUntil).getTime();
      if (Date.now() < until) {
        return { allowed: true, reason: 'Override gate active for this session', tradesCountToday: 0 };
      }
    }

    // Validate configuration
    if (!validateConfig(config)) {
      logger.warn(`[REVENUE_TARGET] Invalid config for user ${userId}, allowing trade with warning`, 'revenue-target');
      return {
        allowed: true,
        reason: 'Invalid revenue target configuration - proceeding with caution',
        fallbackMode: true
      };
    }

    const progress = await revenueTargetProgress.getTodayProgress(userId);
    const { realizedToday, tradesCountToday } = progress;
    const target = config.dailyTarget;
    const maxTrades = config.maxTradesPerDay;
    const remainingTarget = Math.max(0, target - realizedToday);

    if (tradesCountToday >= maxTrades) {
      return {
        allowed: false,
        reason: `Max trades per day (${maxTrades}) reached`,
        remainingTarget,
        tradesCountToday,
      };
    }

    if (realizedToday >= target && config.aggressionMode === 'conservative') {
      return {
        allowed: false,
        reason: `Daily target $${target} met (realized $${realizedToday.toFixed(2)})`,
        remainingTarget: 0,
        tradesCountToday,
      };
    }

    if (realizedToday >= target && config.aggressionMode === 'balanced') {
      return {
        allowed: false,
        reason: `Daily target $${target} met`,
        remainingTarget: 0,
        tradesCountToday,
      };
    }

    return {
      allowed: true,
      reason: `Target $${target} remaining $${remainingTarget.toFixed(2)} trades=${tradesCountToday}/${maxTrades}`,
      remainingTarget,
      tradesCountToday,
    };
  } catch (error) {
    logger.error(`[REVENUE_TARGET] Gate check failed for user ${userId}: ${error.message}`, 'revenue-target');

    // Check if external services are healthy to determine fallback strategy
    const servicesHealthy = await areServicesHealthy();
    const allowFallback = options.allowFallback || !servicesHealthy;

    // Fallback mode: allow trades but log the issue
    if (allowFallback) {
      logger.warn(`[REVENUE_TARGET] Using fallback mode for user ${userId} due to gate failure`, 'revenue-target');
      return {
        allowed: true,
        reason: 'Revenue target service unavailable - proceeding with caution',
        fallbackMode: true
      };
    }

    // Strict mode: block trades on errors
    return {
      allowed: false,
      reason: 'Revenue target service error - blocking trade for safety',
    };
  }
}

/**
 * Check if a candidate trade's credit meets the minimum threshold.
 * @param {string} userId
 * @param {number} creditPerContract - Credit received per contract (e.g. from spread)
 * @returns {Promise<{ pass: boolean, reason?: string }>}
 */
async function meetsMinCredit(userId, creditPerContract) {
  const config = await revenueTargetConfig.getConfig(userId);
  if (!config.enabled) return { pass: true };

  const minCredit = config.minCreditPerTrade;
  if (creditPerContract < minCredit) {
    return {
      pass: false,
      reason: `Credit $${creditPerContract.toFixed(2)} < min $${minCredit}`,
    };
  }
  return { pass: true };
}

module.exports = {
  shouldAllowNewTrades,
  meetsMinCredit,
};
