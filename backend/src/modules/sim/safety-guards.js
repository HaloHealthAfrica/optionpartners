'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');
const { isWithinTradingHours, getETDate } = require('../../utils/timezone');

/**
 * @typedef {Object} SafetyConfig
 * @property {number} maxDailyLoss          - Max daily loss in dollars (default: 2000)
 * @property {number} maxRiskPerTrade       - Max risk per trade in dollars (default: 1000)
 * @property {number} maxOpenPositions      - Max concurrent open positions (default: 5)
 * @property {number} maxDteBucketExposure  - Max positions per DTE bucket (default: 3)
 * @property {boolean} killSwitchActive     - Emergency stop flag
 * @property {string} tradingStartTime      - Earliest trade time HH:MM (default: "09:30")
 * @property {string} tradingEndTime        - Latest trade time HH:MM (default: "16:00")
 * @property {number} maxSignalAgeMs        - Max age for signal staleness (default: 300000 = 5min)
 */

const DEFAULT_CONFIG = {
  maxDailyLoss: parseFloat(process.env.SIM_MAX_DAILY_LOSS || '2000'),
  maxRiskPerTrade: parseFloat(process.env.SIM_MAX_RISK_PER_TRADE || '1000'),
  maxOpenPositions: parseInt(process.env.SIM_MAX_OPEN_POSITIONS || '5', 10),
  maxDteBucketExposure: parseInt(process.env.SIM_MAX_DTE_BUCKET || '3', 10),
  killSwitchActive: process.env.SIM_KILL_SWITCH === 'true',
  tradingStartTime: process.env.SIM_TRADING_START || '09:00',
  tradingEndTime: process.env.SIM_TRADING_END || '16:00',
  maxSignalAgeMs: parseInt(process.env.SIM_MAX_SIGNAL_AGE_MS || '300000', 10),
};

class SafetyGuards {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run all safety checks. Returns { safe: boolean, violations: string[] }
   */
  async evaluate(signal, accountState, userId) {
    const violations = [];

    // Kill switch — auto-reset at start of new trading day
    const isStaleDay = accountState?.daily_pnl_reset_at
      && getETDate() > String(accountState.daily_pnl_reset_at).slice(0, 10);
    const effectiveKillSwitch = isStaleDay ? false : (accountState?.kill_switch_active || false);

    if (this.config.killSwitchActive || effectiveKillSwitch) {
      const source = this.config.killSwitchActive ? 'ENV_CONFIG' : 'DB_ACCOUNT_STATE';
      violations.push('Kill switch is active');
      logger.warn(
        `[KILL_SWITCH] Triggered for user ${userId} — source=${source}, ` +
        `symbol=${signal?.symbol || 'N/A'}, strategy=${signal?.strategy || 'N/A'}, ` +
        `daily_pnl=${accountState?.daily_pnl || 'N/A'}, ` +
        `isStaleDay=${isStaleDay}`,
        'sim-safety'
      );
      return { safe: false, violations };
    }

    // Max daily loss — treat stale daily_pnl as 0 for a new trading day
    if (accountState) {
      const effectiveDailyPnl = isStaleDay ? 0 : (accountState.daily_pnl || 0);
      const dailyLoss = Math.abs(Math.min(0, effectiveDailyPnl));
      if (dailyLoss >= this.config.maxDailyLoss) {
        violations.push(`Daily loss limit reached: $${dailyLoss.toFixed(2)} >= $${this.config.maxDailyLoss}`);
      }
    }

    // Max risk per trade
    if (signal.action === 'BUY') {
      const estimatedRisk = this._estimateRisk(signal);
      if (estimatedRisk > this.config.maxRiskPerTrade) {
        violations.push(`Trade risk $${estimatedRisk.toFixed(2)} exceeds max $${this.config.maxRiskPerTrade}`);
      }
    }

    // Max open positions
    if (signal.action === 'BUY' && userId) {
      const openCount = await this._getOpenPositionCount(userId);
      if (openCount >= this.config.maxOpenPositions) {
        violations.push(`Max open positions reached: ${openCount} >= ${this.config.maxOpenPositions}`);
      }
    }

    // DTE bucket exposure
    if (signal.action === 'BUY' && signal.expiration && userId) {
      const dteBucket = this._getDteBucket(signal.expiration);
      const bucketCount = await this._getDteBucketCount(userId, dteBucket);
      if (bucketCount >= this.config.maxDteBucketExposure) {
        violations.push(`DTE bucket "${dteBucket}" exposure at max: ${bucketCount} >= ${this.config.maxDteBucketExposure}`);
      }
    }

    // Time-of-day filter
    const timeCheck = this._checkTradingHours();
    if (!timeCheck.allowed) {
      violations.push(timeCheck.reason);
    }

    // Signal staleness
    if (signal.meta?.originalPayload) {
      const ts = signal.meta.originalPayload.time || signal.meta.originalPayload.timestamp;
      if (ts) {
        let payloadTimeMs;
        const numericTs = typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : ts;
        if (typeof numericTs === 'number') {
          payloadTimeMs = numericTs < 1e10 ? numericTs * 1000 : numericTs;
        } else {
          payloadTimeMs = new Date(ts).getTime();
        }
        const age = Date.now() - payloadTimeMs;
        if (!isNaN(age) && age > this.config.maxSignalAgeMs) {
          violations.push(`Signal is stale: ${Math.round(age / 1000)}s old (max ${this.config.maxSignalAgeMs / 1000}s)`);
        }
      }
    }

    return {
      safe: violations.length === 0,
      violations,
    };
  }

  _estimateRisk(signal) {
    const multiplier = signal.contractType === 'STOCK' ? 1 : 100;
    const optionPrice = signal.midPrice || signal.askPrice || null;

    if (signal.contractType === 'CREDIT_SPREAD') {
      const price = optionPrice || signal.limitPrice || 0;
      const width = Math.abs((signal.strikeShort || 0) - (signal.strikeLong || 0));
      return (width - price) * multiplier * signal.quantity;
    }

    // If we have an actual option price (from construction), use premium as risk
    if (optionPrice) {
      return optionPrice * multiplier * signal.quantity;
    }

    // Pre-construction: limitPrice is the underlying price, not option premium.
    // Use stop-loss distance as risk proxy when available.
    if (signal.stopLoss && signal.limitPrice) {
      return Math.abs(signal.limitPrice - signal.stopLoss) * multiplier * signal.quantity;
    }

    // Fallback: 2% of underlying as rough risk estimate
    const price = signal.limitPrice || 0;
    return price * 0.02 * multiplier * signal.quantity;
  }

  async _getOpenPositionCount(userId) {
    const result = await db.query(
      `SELECT COUNT(*) as count FROM sim_positions WHERE user_id = $1 AND status = 'OPEN'`,
      [userId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  _getDteBucket(expiration) {
    const dte = Math.ceil((new Date(expiration) - Date.now()) / (1000 * 60 * 60 * 24));
    if (dte <= 0) return '0DTE';
    if (dte <= 2) return '1-2DTE';
    if (dte <= 7) return '3-7DTE';
    if (dte <= 21) return '8-21DTE';
    if (dte <= 45) return '22-45DTE';
    return '45+DTE';
  }

  async _getDteBucketCount(userId, bucket) {
    const now = new Date();
    let minDte, maxDte;

    switch (bucket) {
      case '0DTE': minDte = 0; maxDte = 0; break;
      case '1-2DTE': minDte = 1; maxDte = 2; break;
      case '3-7DTE': minDte = 3; maxDte = 7; break;
      case '8-21DTE': minDte = 8; maxDte = 21; break;
      case '22-45DTE': minDte = 22; maxDte = 45; break;
      default: minDte = 46; maxDte = 9999; break;
    }

    const result = await db.query(
      `SELECT COUNT(*) as count FROM sim_positions
       WHERE user_id = $1 AND status = 'OPEN'
       AND expiration IS NOT NULL
       AND (expiration - CURRENT_DATE) BETWEEN $2 AND $3`,
      [userId, minDte, maxDte]
    );
    return parseInt(result.rows[0].count, 10);
  }

  _checkTradingHours() {
    return isWithinTradingHours(this.config.tradingStartTime, this.config.tradingEndTime);
  }

  /**
   * Activate kill switch for user. Logs reason for audit trail.
   */
  async activateKillSwitch(userId, reason = 'manual') {
    await db.query(
      `UPDATE sim_account_state SET kill_switch_active = TRUE, updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );

    // Log to signal_rejections for audit trail
    try {
      await db.query(
        `INSERT INTO signal_rejections (user_id, symbol, strategy, action, reason, gate, rejection_reason)
         VALUES ($1, 'SYSTEM', 'KILL_SWITCH', 'ACTIVATE', $2, 'SAFETY_GUARD', 'kill_switch_activated')`,
        [userId, `Kill switch activated: ${reason}`]
      );
    } catch (_) { /* best effort audit log */ }

    logger.warn(`Kill switch activated for user ${userId}: ${reason}`, 'sim-safety');
  }

  /**
   * Deactivate kill switch for user
   */
  async deactivateKillSwitch(userId, reason = 'manual') {
    await db.query(
      `UPDATE sim_account_state SET kill_switch_active = FALSE, updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );

    try {
      await db.query(
        `INSERT INTO signal_rejections (user_id, symbol, strategy, action, reason, gate, rejection_reason)
         VALUES ($1, 'SYSTEM', 'KILL_SWITCH', 'DEACTIVATE', $2, 'SAFETY_GUARD', 'kill_switch_deactivated')`,
        [userId, `Kill switch deactivated: ${reason}`]
      );
    } catch (_) { /* best effort audit log */ }

    logger.info(`Kill switch deactivated for user ${userId}: ${reason}`, 'sim-safety');
  }
}

module.exports = new SafetyGuards();
module.exports.SafetyGuards = SafetyGuards;
