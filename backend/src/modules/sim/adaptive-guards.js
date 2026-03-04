'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');
const { getETDate } = require('../../utils/timezone');

const CORRELATION_GROUPS = {
  BROAD_INDEX: ['SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'SPX', 'ES', 'NQ', 'RTY', 'YM'],
  MEGA_TECH: ['AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'NVDA', 'TSLA'],
  SEMIS: ['NVDA', 'AMD', 'INTC', 'SMH', 'AVGO', 'MU', 'QCOM', 'SOXX'],
  FINANCIALS: ['JPM', 'BAC', 'GS', 'MS', 'WFC', 'C', 'XLF'],
  ENERGY: ['XOM', 'CVX', 'COP', 'SLB', 'XLE', 'OXY', 'USO'],
};

function getCorrelationGroup(symbol) {
  const upper = (symbol || '').toUpperCase();
  for (const [group, members] of Object.entries(CORRELATION_GROUPS)) {
    if (members.includes(upper)) return group;
  }
  return null;
}

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

    // 2. Signal deduplication — block near-duplicate signals for the same symbol/direction
    const cooldownMs = parseInt(config.signal_dedup_cooldown_ms || process.env.SIM_SIGNAL_DEDUP_COOLDOWN_MS || '300000', 10); // 5 min default
    const dedupResult = await this._checkSignalDedup(userId, signal, cooldownMs);
    if (!dedupResult.allowed) return dedupResult;

    // 3. Correlation guard
    const maxCorrelated = config.max_correlated_positions || 3;
    const correlationResult = await this._checkCorrelation(userId, signal, maxCorrelated);
    if (!correlationResult.allowed) return correlationResult;

    // 4. Drawdown throttle
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

    const allLosses = recentTrades.rows.every(t => parseFloat(t.pnl) < 0);
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

    // If an expired cooldown exists, delete it and allow the strategy to trade.
    // This prevents the infinite re-trigger loop where the same historical losses
    // kept re-creating the cooldown after it expired.
    const expired = await db.query(
      `DELETE FROM strategy_cooldowns
       WHERE user_id = $1 AND strategy = $2 AND cooldown_until <= NOW()
       RETURNING *`,
      [userId, strategy]
    );
    if (expired.rows.length > 0) {
      logger.info(
        `Strategy cooldown expired for ${strategy} — allowing trade (was paused since ${expired.rows[0].created_at})`,
        'adaptive-guards'
      );
    }

    return { allowed: true };
  }

  async _checkSignalDedup(userId, signal, cooldownMs) {
    const underlying = signal.underlyingSymbol || signal.symbol?.replace(/\d{6}[CP]\d+/, '') || signal.symbol;
    const direction = signal.direction || (signal.action === 'BUY' ? 'long' : 'short');
    const side = direction === 'long' ? 'BUY' : 'SELL';

    // Check actual filled orders, not just approved verdicts — a verdict that
    // was approved but rejected by the executor shouldn't block re-entry.
    const result = await db.query(
      `SELECT o.created_at
       FROM sim_orders o
       WHERE o.user_id = $1
         AND o.symbol = $2
         AND o.side = $3
         AND o.status = 'FILLED'
         AND o.created_at > NOW() - ($4 || ' milliseconds')::interval
       ORDER BY o.created_at DESC
       LIMIT 1`,
      [userId, underlying, side, cooldownMs]
    );

    if (result.rows.length > 0) {
      const lastAt = result.rows[0].created_at;
      const agoSec = Math.round((Date.now() - new Date(lastAt).getTime()) / 1000);
      return {
        allowed: false,
        reason: `SIGNAL_DEDUP: ${underlying} ${direction} already filled ${agoSec}s ago (cooldown ${Math.round(cooldownMs / 1000)}s)`,
      };
    }

    return { allowed: true };
  }

  async _checkCorrelation(userId, signal, maxCorrelated) {
    const underlying = signal.underlyingSymbol || signal.symbol?.replace(/\d{6}[CP]\d+/, '') || signal.symbol;

    // Same-symbol check
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

    // Sector/group correlation check
    const group = getCorrelationGroup(underlying);
    if (group) {
      const groupMembers = CORRELATION_GROUPS[group];
      const maxGroupExposure = maxCorrelated + 1;
      const placeholders = groupMembers.map((_, i) => `$${i + 2}`).join(', ');
      const groupResult = await db.query(
        `SELECT COUNT(*) as count FROM sim_positions
         WHERE user_id = $1 AND status = 'OPEN'
           AND underlying_symbol IN (${placeholders})`,
        [userId, ...groupMembers]
      );
      const groupCount = parseInt(groupResult.rows[0].count, 10);
      if (groupCount >= maxGroupExposure) {
        return {
          allowed: false,
          reason: `CORRELATION_GUARD: ${groupCount} open positions in ${group} group (max ${maxGroupExposure})`,
        };
      }
    }

    return { allowed: true };
  }

  _checkDrawdownThrottle(signal, accountState, config) {
    const isNewDay = accountState.daily_pnl_reset_at
      && getETDate() > String(accountState.daily_pnl_reset_at).slice(0, 10);
    const dailyPnl = isNewDay ? 0 : parseFloat(accountState.daily_pnl || 0);
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
