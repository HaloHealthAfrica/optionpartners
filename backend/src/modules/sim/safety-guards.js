'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');

/**
 * @typedef {Object} SafetyConfig
 * @property {number} maxDailyLoss          - Max daily loss in dollars (default: 2000)
 * @property {number} maxRiskPerTrade       - Max risk per trade in dollars (default: 500)
 * @property {number} maxOpenPositions      - Max concurrent open positions (default: 5)
 * @property {number} maxDteBucketExposure  - Max positions per DTE bucket (default: 3)
 * @property {boolean} killSwitchActive     - Emergency stop flag
 * @property {string} tradingStartTime      - Earliest trade time HH:MM (default: "09:30")
 * @property {string} tradingEndTime        - Latest trade time HH:MM (default: "16:00")
 * @property {number} maxSignalAgeMs        - Max age for signal staleness (default: 300000 = 5min)
 */

const DEFAULT_CONFIG = {
  maxDailyLoss: parseFloat(process.env.SIM_MAX_DAILY_LOSS || '2000'),
  maxRiskPerTrade: parseFloat(process.env.SIM_MAX_RISK_PER_TRADE || '500'),
  maxOpenPositions: parseInt(process.env.SIM_MAX_OPEN_POSITIONS || '5', 10),
  maxDteBucketExposure: parseInt(process.env.SIM_MAX_DTE_BUCKET || '3', 10),
  killSwitchActive: process.env.SIM_KILL_SWITCH === 'true',
  tradingStartTime: process.env.SIM_TRADING_START || '09:30',
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

    // Kill switch
    if (this.config.killSwitchActive || accountState?.kill_switch_active) {
      violations.push('Kill switch is active');
      return { safe: false, violations };
    }

    // Max daily loss
    if (accountState) {
      const dailyLoss = Math.abs(Math.min(0, accountState.daily_pnl || 0));
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
        const age = Date.now() - new Date(ts).getTime();
        if (age > this.config.maxSignalAgeMs) {
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
    const price = signal.midPrice || signal.askPrice || signal.limitPrice || 0;

    if (signal.contractType === 'CREDIT_SPREAD') {
      const width = Math.abs((signal.strikeShort || 0) - (signal.strikeLong || 0));
      return (width - price) * multiplier * signal.quantity;
    }

    return price * multiplier * signal.quantity;
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
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentMinutes = hours * 60 + minutes;

    const [startH, startM] = this.config.tradingStartTime.split(':').map(Number);
    const [endH, endM] = this.config.tradingEndTime.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
      return {
        allowed: false,
        reason: `Outside trading hours: current ${hours}:${String(minutes).padStart(2, '0')}, allowed ${this.config.tradingStartTime}-${this.config.tradingEndTime}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Activate kill switch for user
   */
  async activateKillSwitch(userId) {
    await db.query(
      `UPDATE sim_account_state SET kill_switch_active = TRUE, updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );
    logger.warn(`Kill switch activated for user ${userId}`, 'sim-safety');
  }

  /**
   * Deactivate kill switch for user
   */
  async deactivateKillSwitch(userId) {
    await db.query(
      `UPDATE sim_account_state SET kill_switch_active = FALSE, updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );
    logger.info(`Kill switch deactivated for user ${userId}`, 'sim-safety');
  }
}

module.exports = new SafetyGuards();
module.exports.SafetyGuards = SafetyGuards;
