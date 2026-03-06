'use strict';

const db = require('../../../config/database');
const logger = require('../../../utils/logger');
const simEventBus = require('../sim-event-bus');
const AIProvider = require('../../../utils/aiProvider');
const AISessionService = require('../../../services/aiSessionService');
const liveContext = require('./live-context.service');

/**
 * AutoInsightService — Triggers lightweight AI analysis after every N trades.
 *
 * Compares current performance metrics to the last snapshot.
 * If meaningful drift is detected, generates a brief AI insight and
 * emits it via SimEventBus so the frontend can show a notification.
 */
class AutoInsightService {
  constructor() {
    this.DEFAULT_TRADE_INTERVAL = 25;
  }

  /**
   * Check if an auto-insight should be triggered and generate it if so.
   * Called from trade-finalizer after incrementTradeCount.
   *
   * @param {string} userId
   * @param {number} tradeCount - Current trade count since last calibration
   * @param {Object} latestTrade - The trade that just closed
   * @returns {Promise<Object|null>} Insight or null if not triggered
   */
  async checkAndGenerate(userId, tradeCount, latestTrade) {
    try {
      const config = await this._getConfig(userId);
      const interval = config?.autoInsightInterval || this.DEFAULT_TRADE_INTERVAL;

      if (tradeCount % interval !== 0) return null;

      logger.info(`[AUTO_INSIGHT] Triggered for user ${userId} at trade #${tradeCount}`, 'auto-insight');

      const [currentMetrics, lastInsight] = await Promise.all([
        this._getCurrentMetrics(userId),
        this._getLastInsight(userId),
      ]);

      if (!currentMetrics || currentMetrics.totalTrades < 10) return null;

      const prompt = this._buildQuickPrompt(currentMetrics, lastInsight?.metrics, tradeCount);
      const aiSettings = await AISessionService.getAISettings(userId, {});

      const analysis = await AIProvider.generateResponse(prompt, aiSettings);

      const insight = await this._storeInsight(userId, analysis, currentMetrics, tradeCount);

      simEventBus.sendToUser(userId, 'insight:auto', {
        id: insight.id,
        summary: analysis.substring(0, 300),
        tradeCount,
        generatedAt: insight.created_at,
      });

      simEventBus.emit('insight:auto', { userId, insight });

      return insight;
    } catch (err) {
      logger.error(`[AUTO_INSIGHT] Failed for user ${userId}: ${err.message}`, 'auto-insight');
      return null;
    }
  }

  /**
   * Get the latest auto-insight for a user.
   */
  async getLatestInsight(userId) {
    const result = await db.query(
      `SELECT id, analysis, metrics, trade_count, is_read, created_at
       FROM ai_auto_insights
       WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get unread insight count for notification badge.
   */
  async getUnreadCount(userId) {
    const result = await db.query(
      `SELECT COUNT(*) as count FROM ai_auto_insights
       WHERE user_id = $1 AND is_read = false`,
      [userId]
    );
    return parseInt(result.rows[0].count);
  }

  /**
   * Mark insights as read.
   */
  async markRead(userId) {
    await db.query(
      `UPDATE ai_auto_insights SET is_read = true WHERE user_id = $1 AND is_read = false`,
      [userId]
    );
  }

  async _getConfig(userId) {
    try {
      const result = await db.query(
        `SELECT auto_insight_interval FROM sim_intelligence_config WHERE user_id = $1`,
        [userId]
      );
      return result.rows[0] || null;
    } catch {
      return null;
    }
  }

  async _getCurrentMetrics(userId) {
    try {
      const result = await db.query(
        `SELECT
           COUNT(*) as total_trades,
           COUNT(*) FILTER (WHERE pnl > 0) as wins,
           COUNT(*) FILTER (WHERE pnl <= 0) as losses,
           COALESCE(SUM(pnl), 0) as total_pnl,
           COALESCE(AVG(pnl), 0) as avg_pnl,
           COALESCE(MAX(pnl), 0) as best_trade,
           COALESCE(MIN(pnl), 0) as worst_trade,
           CASE WHEN SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END) > 0
             THEN SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END) / SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END)
             ELSE 0 END as profit_factor
         FROM sim_trades
         WHERE user_id = $1 AND exit_time > NOW() - INTERVAL '90 days'`,
        [userId]
      );
      const row = result.rows[0];
      return {
        totalTrades: parseInt(row.total_trades),
        wins: parseInt(row.wins),
        losses: parseInt(row.losses),
        winRate: row.total_trades > 0 ? (parseInt(row.wins) / parseInt(row.total_trades) * 100).toFixed(1) : '0',
        totalPnl: parseFloat(row.total_pnl).toFixed(2),
        avgPnl: parseFloat(row.avg_pnl).toFixed(2),
        bestTrade: parseFloat(row.best_trade).toFixed(2),
        worstTrade: parseFloat(row.worst_trade).toFixed(2),
        profitFactor: parseFloat(row.profit_factor).toFixed(2),
      };
    } catch {
      return null;
    }
  }

  async _getLastInsight(userId) {
    try {
      const result = await db.query(
        `SELECT metrics FROM ai_auto_insights WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      return result.rows[0] || null;
    } catch {
      return null;
    }
  }

  async _storeInsight(userId, analysis, metrics, tradeCount) {
    const result = await db.query(
      `INSERT INTO ai_auto_insights (user_id, analysis, metrics, trade_count, is_read)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id, created_at`,
      [userId, analysis, JSON.stringify(metrics), tradeCount]
    );
    return result.rows[0];
  }

  _buildQuickPrompt(current, previous, tradeCount) {
    let prompt = `You are a trading system monitor. Provide a BRIEF (3-5 sentences) performance update for an automated options trading system.

Be specific with numbers. Highlight what changed and what needs attention. No fluff.

CURRENT METRICS (last 90 days):
- Trades: ${current.totalTrades} (${current.wins}W / ${current.losses}L)
- Win Rate: ${current.winRate}%
- Total P&L: $${current.totalPnl}
- Avg Trade: $${current.avgPnl}
- Profit Factor: ${current.profitFactor}
- Best: $${current.bestTrade}, Worst: $${current.worstTrade}
- This is trade #${tradeCount} since last calibration.`;

    if (previous) {
      prompt += `\n\nPREVIOUS SNAPSHOT:
- Win Rate was: ${previous.winRate}%
- Total P&L was: $${previous.totalPnl}
- Profit Factor was: ${previous.profitFactor}

Compare and note any drift.`;
    }

    prompt += '\n\nRespond in 3-5 sentences. Start with the most important observation.';
    return prompt;
  }
}

module.exports = new AutoInsightService();
