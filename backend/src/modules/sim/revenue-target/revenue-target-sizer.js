'use strict';

const revenueTargetConfig = require('./revenue-target-config.service');
const revenueTargetProgress = require('./revenue-target-progress.service');
const logger = require('../../../utils/logger');

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
 * Compute a size multiplier adjustment based on revenue target progress.
 * When ahead of target: reduce size to avoid overtrading.
 * When behind and aggressive: allow slight size boost (capped).
 *
 * @param {string} userId
 * @param {number} baseMultiplier - From conviction (e.g. 0.5, 1.0, 1.25)
 * @param {Object} [options] - Additional context
 * @param {boolean} [options.allowFallback] - Allow fallback mode on errors
 * @returns {Promise<{ multiplier: number, reason: string, fallbackMode?: boolean }>}
 */
async function getSizeAdjustment(userId, baseMultiplier, options = {}) {
  try {
    // Validate base multiplier
    if (!isFinite(baseMultiplier) || baseMultiplier <= 0) {
      logger.warn(`[REVENUE_TARGET] Invalid base multiplier ${baseMultiplier} for user ${userId}`, 'revenue-target');
      return { multiplier: 1.0, reason: 'Invalid base multiplier - using default sizing' };
    }

    const config = await revenueTargetConfig.getConfig(userId);
    if (!config.enabled) {
      return { multiplier: 1.0, reason: 'Revenue target disabled' };
    }

    // Validate configuration
    if (!validateConfig(config)) {
      logger.warn(`[REVENUE_TARGET] Invalid config for user ${userId}, using conservative sizing`, 'revenue-target');
      return { multiplier: Math.min(baseMultiplier, 0.75), reason: 'Invalid configuration - using conservative sizing', fallbackMode: true };
    }

    const progress = await revenueTargetProgress.getTodayProgress(userId);
    const { realizedToday, tradesCountToday } = progress;
    const target = config.dailyTarget;
    const remainingTarget = Math.max(0, target - realizedToday);

    if (remainingTarget <= 0) {
      return { multiplier: 0, reason: 'Daily target met — no new trades' };
    }

    if (tradesCountToday >= config.maxTradesPerDay) {
      return { multiplier: 0, reason: 'Max trades per day reached' };
    }

    const targetPerTrade = target / config.maxTradesPerDay;
    const remainingTrades = config.maxTradesPerDay - tradesCountToday;
    const effectiveTargetPerTrade = remainingTarget / Math.max(1, remainingTrades);

    const scale1 = (config.scaleBack1Pct ?? 80) / 100;
    const scale2 = (config.scaleBack2Pct ?? 50) / 100;
    const aggMax = config.aggressiveMax ?? 1.25;
    const aggCap = config.aggressiveCap ?? 1.5;

    let adj = 1.0;
    let reason = '';

    if (realizedToday >= target * scale1) {
      adj = 0.5;
      reason = 'Near target — reduce size';
    } else if (realizedToday >= target * scale2) {
      adj = 0.75;
      reason = 'Moderate progress — slight size reduction';
    } else if (remainingTarget > target * 0.5 && config.aggressionMode === 'aggressive') {
      const maxBoost = Math.min(aggMax, 1 + (remainingTarget / target) * 0.25);
      adj = Math.min(maxBoost, aggCap);
      reason = `Behind target — aggressive mode allows up to ${aggMax}x`;
    } else {
      reason = 'Normal sizing';
    }

    const finalMultiplier = Math.max(0, Math.round(baseMultiplier * adj * 100) / 100);
    return {
      multiplier: finalMultiplier,
      reason: `${reason} (base=${baseMultiplier} adj=${adj} → ${finalMultiplier})`,
    };
  } catch (error) {
    logger.error(`[REVENUE_TARGET] Size adjustment failed for user ${userId}: ${error.message}`, 'revenue-target');

    // Fallback: use conservative sizing
    if (options.allowFallback) {
      const safeMultiplier = Math.min(baseMultiplier * 0.75, 1.0);
      return {
        multiplier: Math.max(0, safeMultiplier),
        reason: 'Revenue target service error - using conservative sizing',
        fallbackMode: true
      };
    }

    // Strict mode: block trades
    return { multiplier: 0, reason: 'Revenue target service error - blocking trade' };
  }
}

module.exports = {
  getSizeAdjustment,
};
