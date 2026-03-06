'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');

/**
 * Maintains a rolling strategy scorecard per user.
 * Recalculated after each trade close or on demand.
 *
 * Metrics (per strategy, last N trades):
 *   - Win rate
 *   - Profit factor (gross wins / |gross losses|)
 *   - Average R-multiple
 *   - Average PnL / StdDev PnL (Sharpe-like)
 *   - Current streak (win/loss)
 */
class StrategyScorecardService {
  /**
   * Recalculate scorecard for a specific strategy after a trade closes.
   */
  async recalculate(userId, strategy) {
    const config = await this._getConfig(userId);
    const windowSize = config.scorecard_window || 20;

    const trades = await db.query(
      `SELECT pnl, r_multiple FROM sim_trades
       WHERE user_id = $1 AND strategy = $2
       ORDER BY exit_time DESC
       LIMIT $3`,
      [userId, strategy, windowSize]
    );

    if (trades.rows.length === 0) return null;

    const pnls = trades.rows.map(t => parseFloat(t.pnl));
    const rMultiples = trades.rows.filter(t => t.r_multiple != null).map(t => parseFloat(t.r_multiple));

    const totalTrades = pnls.length;
    const winningTrades = pnls.filter(p => p > 0).length;
    const losingTrades = pnls.filter(p => p <= 0).length;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

    const grossWins = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const grossLosses = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
    // PF=999 is a sentinel for "no losses" — must be handled as a special case,
    // not as a literal 999x profit factor in sizing or filtering decisions.
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 999 : 0);
    const profitFactorIsReal = grossLosses > 0;

    const avgRMultiple = rMultiples.length > 0
      ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length
      : null;

    const avgPnl = pnls.reduce((a, b) => a + b, 0) / totalTrades;
    const variance = pnls.reduce((sum, p) => sum + Math.pow(p - avgPnl, 2), 0) / totalTrades;
    const stddevPnl = Math.sqrt(variance);
    const sharpeRatio = stddevPnl > 0 ? avgPnl / stddevPnl : 0;

    // Current streak: count from most recent trade backwards
    let currentStreak = 0;
    let streakType = 'none';
    if (pnls.length > 0) {
      streakType = pnls[0] > 0 ? 'win' : 'loss';
      for (const p of pnls) {
        if ((streakType === 'win' && p > 0) || (streakType === 'loss' && p <= 0)) {
          currentStreak++;
        } else {
          break;
        }
      }
    }

    // Determine status
    let status = 'ACTIVE';
    if (totalTrades >= 5) {
      const minWinRate = parseFloat(config.min_win_rate || 0.40);
      const minProfitFactor = parseFloat(config.min_profit_factor || 1.0);
      if (winRate < minWinRate || profitFactor < minProfitFactor) {
        status = 'UNDERPERFORMING';
      }
    }

    await db.query(
      `INSERT INTO strategy_scorecard
        (user_id, strategy, window_size, total_trades, winning_trades, losing_trades,
         win_rate, profit_factor, avg_r_multiple, avg_pnl, stddev_pnl, sharpe_ratio,
         current_streak, streak_type, gross_wins, gross_losses, status, last_recalculated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
       ON CONFLICT (user_id, strategy) DO UPDATE SET
         window_size = EXCLUDED.window_size,
         total_trades = EXCLUDED.total_trades,
         winning_trades = EXCLUDED.winning_trades,
         losing_trades = EXCLUDED.losing_trades,
         win_rate = EXCLUDED.win_rate,
         profit_factor = EXCLUDED.profit_factor,
         avg_r_multiple = EXCLUDED.avg_r_multiple,
         avg_pnl = EXCLUDED.avg_pnl,
         stddev_pnl = EXCLUDED.stddev_pnl,
         sharpe_ratio = EXCLUDED.sharpe_ratio,
         current_streak = EXCLUDED.current_streak,
         streak_type = EXCLUDED.streak_type,
         gross_wins = EXCLUDED.gross_wins,
         gross_losses = EXCLUDED.gross_losses,
         status = EXCLUDED.status,
         last_recalculated_at = NOW(),
         updated_at = NOW()
       RETURNING *`,
      [userId, strategy, windowSize, totalTrades, winningTrades, losingTrades,
       winRate, profitFactor, avgRMultiple, avgPnl, stddevPnl, sharpeRatio,
       currentStreak, streakType, grossWins, grossLosses, status]
    );

    logger.info(
      `Scorecard updated: ${strategy} — WR=${(winRate * 100).toFixed(1)}% PF=${profitFactor.toFixed(2)} streak=${currentStreak}${streakType[0]} status=${status}`,
      'strategy-scorecard'
    );

    return { strategy, winRate, profitFactor, avgRMultiple, sharpeRatio, currentStreak, streakType, status };
  }

  /**
   * Recalculate all strategies for a user
   */
  async recalculateAll(userId) {
    const strategies = await db.query(
      'SELECT DISTINCT strategy FROM sim_trades WHERE user_id = $1 AND strategy IS NOT NULL',
      [userId]
    );

    const results = [];
    for (const row of strategies.rows) {
      const result = await this.recalculate(userId, row.strategy);
      if (result) results.push(result);
    }
    return results;
  }

  /**
   * Get scorecard for a specific strategy (used by strategy gate)
   */
  async getScorecard(userId, strategy) {
    const result = await db.query(
      'SELECT * FROM strategy_scorecard WHERE user_id = $1 AND strategy = $2',
      [userId, strategy]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all scorecards for a user
   */
  async getAllScorecards(userId) {
    const result = await db.query(
      'SELECT * FROM strategy_scorecard WHERE user_id = $1 ORDER BY total_pnl DESC NULLS LAST',
      [userId]
    );
    return result.rows;
  }

  /**
   * Strategy Gate: check if a strategy should be allowed to trade.
   * Returns { allowed: boolean, reason?: string }
   */
  async checkStrategyGate(userId, strategy) {
    if (!strategy) return { allowed: true };

    const config = await this._getConfig(userId);
    const scorecard = await this.getScorecard(userId, strategy);

    if (!scorecard || scorecard.total_trades < 5) {
      return { allowed: true };
    }

    const winRate = parseFloat(scorecard.win_rate);
    const profitFactor = parseFloat(scorecard.profit_factor);
    const minWinRate = parseFloat(config.min_win_rate || 0.40);
    const minProfitFactor = parseFloat(config.min_profit_factor || 1.0);

    if (winRate < minWinRate) {
      return {
        allowed: false,
        reason: `STRATEGY_UNDERPERFORMING: ${strategy} win rate ${(winRate * 100).toFixed(1)}% < min ${(minWinRate * 100).toFixed(1)}%`,
      };
    }

    // PF=999 is a sentinel for "no losses recorded" — treat as passing
    // (infinite PF is not underperforming, just insufficient loss data)
    const pf = parseFloat(scorecard.profit_factor);
    if (pf !== 999 && pf < minProfitFactor) {
      return {
        allowed: false,
        reason: `STRATEGY_UNDERPERFORMING: ${strategy} profit factor ${pf.toFixed(2)} < min ${minProfitFactor.toFixed(2)}`,
      };
    }

    return { allowed: true };
  }

  async _getConfig(userId) {
    const result = await db.query(
      'SELECT * FROM sim_intelligence_config WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || {};
  }
}

module.exports = new StrategyScorecardService();
