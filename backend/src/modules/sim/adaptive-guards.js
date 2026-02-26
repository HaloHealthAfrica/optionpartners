'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');

/**
 * Adaptive intelligence guards:
 * 1. Strategy cooldown — pause after N consecutive losses
 * 2. Correlation guard — limit same-underlying exposure
 * 3. Drawdown throttle — reduce risk as daily loss climbs
 */
class AdaptiveGuards {
  /**
   * Run all adaptive checks. Returns { allowed: boolean, reason?: string }
   */
  async evaluate(signal, accountState, userId) {
    if (signal.action === 'CLOSE') return { allowed: true };

    const config = await this._getConfig(userId);

    // 1. Strategy cooldown
    if (config.enable_strategy_cooldown !== false) {
      const cooldownResult = await this._checkStrategyCooldown(userId, signal.strategy, config);
      if (!cooldownResult.allowed) return cooldownResult;
    }

    // 2. Correlation guard
    const maxCorrelated = config.max_correlated_positions || 3;
    const correlationResult = await this._checkCorrelation(userId, signal, maxCorrelated);
    if (!correlationResult.allowed) return correlationResult;

    // 3. Drawdown throttle
    if (config.enable_drawdown_throttle !== false && accountState) {
      const throttleResult = this._checkDrawdownThrottle(signal, accountState, config);
      if (!throttleResult.allowed) return throttleResult;
    }

    return { allowed: true };
  }

  /**
   * Record a trade result and manage cooldowns.
   * Call after trade finalization.
   */
  async recordTradeResult(userId, strategy, pnl) {
    if (!strategy) return;

    const config = await this._getConfig(userId);
    const maxLosses = config.cooldown_consecutive_losses || 3;
    const cooldownMinutes = config.cooldown_duration_minutes || 60;

    const recentTrades = await db.query(
      `SELECT pnl FROM sim_trades
       WHERE user_id = $1 AND strategy = $2
       ORDER BY exit_time DESC LIMIT $3`,
      [userId, strategy, maxLosses]
    );

    if (recentTrades.rows.length < maxLosses) return;

    const allLosses = recentTrades.rows.every(t => parseFloat(t.pnl) <= 0);
    if (!allLosses) {
      // Clear any existing cooldown if streak is broken
      await db.query(
        'DELETE FROM strategy_cooldowns WHERE user_id = $1 AND strategy = $2',
        [userId, strategy]
      );
      return;
    }

    const cooldownUntil = new Date(Date.now() + cooldownMinutes * 60 * 1000);
    await db.query(
      `INSERT INTO strategy_cooldowns (user_id, strategy, reason, cooldown_until, consecutive_losses)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, strategy) DO UPDATE SET
         reason = EXCLUDED.reason,
         cooldown_until = EXCLUDED.cooldown_until,
         consecutive_losses = EXCLUDED.consecutive_losses`,
      [userId, strategy,
       `${maxLosses} consecutive losses — paused for ${cooldownMinutes}min`,
       cooldownUntil, maxLosses]
    );

    logger.warn(
      `Strategy cooldown activated: ${strategy} paused until ${cooldownUntil.toISOString()} after ${maxLosses} consecutive losses`,
      'adaptive-guards'
    );
  }

  async _checkStrategyCooldown(userId, strategy, config) {
    if (!strategy) return { allowed: true };

    const result = await db.query(
      `SELECT * FROM strategy_cooldowns
       WHERE user_id = $1 AND strategy = $2 AND cooldown_until > NOW()`,
      [userId, strategy]
    );

    if (result.rows.length > 0) {
      const cooldown = result.rows[0];
      const remainingMs = new Date(cooldown.cooldown_until) - Date.now();
      const remainingMin = Math.ceil(remainingMs / 60000);
      return {
        allowed: false,
        reason: `STRATEGY_COOLDOWN: ${strategy} paused for ${remainingMin}min remaining (${cooldown.consecutive_losses} consecutive losses)`,
      };
    }

    // Also check for consecutive losses even without an existing cooldown record
    const maxLosses = config.cooldown_consecutive_losses || 3;
    const recentTrades = await db.query(
      `SELECT pnl FROM sim_trades
       WHERE user_id = $1 AND strategy = $2
       ORDER BY exit_time DESC LIMIT $3`,
      [userId, strategy, maxLosses]
    );

    if (recentTrades.rows.length >= maxLosses) {
      const allLosses = recentTrades.rows.every(t => parseFloat(t.pnl) <= 0);
      if (allLosses) {
        await this.recordTradeResult(userId, strategy, -1);
        return {
          allowed: false,
          reason: `STRATEGY_COOLDOWN: ${strategy} has ${maxLosses} consecutive losses — auto-paused`,
        };
      }
    }

    return { allowed: true };
  }

  async _checkCorrelation(userId, signal, maxCorrelated) {
    const underlying = signal.underlyingSymbol || signal.symbol?.replace(/\d{6}[CP]\d+/, '') || signal.symbol;

    const result = await db.query(
      `SELECT COUNT(*) as count FROM sim_positions
       WHERE user_id = $1 AND status = 'OPEN'
         AND (underlying_symbol = $2 OR symbol LIKE $3)`,
      [userId, underlying, `${underlying}%`]
    );

    const count = parseInt(result.rows[0].count, 10);
    if (count >= maxCorrelated) {
      return {
        allowed: false,
        reason: `CORRELATION_GUARD: ${count} open positions on ${underlying} (max ${maxCorrelated})`,
      };
    }

    return { allowed: true };
  }

  _checkDrawdownThrottle(signal, accountState, config) {
    const dailyPnl = parseFloat(accountState.daily_pnl || 0);
    if (dailyPnl >= 0) return { allowed: true };

    const maxDailyLoss = parseFloat(process.env.SIM_MAX_DAILY_LOSS || '2000');
    const throttlePct = parseFloat(config.drawdown_throttle_pct || 0.50);
    const throttleThreshold = maxDailyLoss * throttlePct;
    const currentLoss = Math.abs(dailyPnl);

    if (currentLoss >= throttleThreshold) {
      const estimatedRisk = this._estimateSignalRisk(signal);
      const maxRiskPerTrade = parseFloat(process.env.SIM_MAX_RISK_PER_TRADE || '500');
      const reducedMax = maxRiskPerTrade * (1 - (currentLoss / maxDailyLoss));

      if (estimatedRisk > reducedMax) {
        return {
          allowed: false,
          reason: `DRAWDOWN_THROTTLE: Daily loss $${currentLoss.toFixed(2)} at ${((currentLoss / maxDailyLoss) * 100).toFixed(0)}% of max — risk $${estimatedRisk.toFixed(2)} exceeds throttled max $${reducedMax.toFixed(2)}`,
        };
      }
    }

    return { allowed: true };
  }

  _estimateSignalRisk(signal) {
    const multiplier = signal.contractType === 'STOCK' ? 1 : 100;
    const price = signal.midPrice || signal.askPrice || signal.limitPrice || 0;
    const qty = signal.quantity || 1;

    if (signal.contractType === 'CREDIT_SPREAD') {
      const width = Math.abs((signal.strikeShort || 0) - (signal.strikeLong || 0));
      return (width - price) * multiplier * qty;
    }
    return price * multiplier * qty;
  }

  async _getConfig(userId) {
    const result = await db.query(
      'SELECT * FROM sim_intelligence_config WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || {};
  }

  /**
   * Get active cooldowns for dashboard
   */
  async getActiveCooldowns(userId) {
    const result = await db.query(
      `SELECT * FROM strategy_cooldowns
       WHERE user_id = $1 AND cooldown_until > NOW()
       ORDER BY cooldown_until DESC`,
      [userId]
    );
    return result.rows;
  }
}

module.exports = new AdaptiveGuards();
