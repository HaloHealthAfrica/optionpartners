'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');

/**
 * Signal Priority Queue — when multiple signals arrive in the same polling cycle
 * and position slots are limited, score and rank them.
 *
 * Score formula: (strategy_win_rate × avg_r_multiple) + delta_bonus + dte_preference
 */
class SignalPrioritizer {
  /**
   * Score and sort an array of { event, decision } pairs.
   * Returns them sorted highest-score-first.
   */
  async prioritize(approvedDecisions, userId) {
    if (approvedDecisions.length <= 1) return approvedDecisions;

    const config = await this._getConfig(userId);
    if (config.enable_signal_priority === false) return approvedDecisions;

    const scored = await Promise.all(
      approvedDecisions.map(async (item) => {
        const score = await this._scoreSignal(item.decision.signal, userId);
        return { ...item, score };
      })
    );

    const withIntel = this.incorporateIntelligence(scored);
    withIntel.sort((a, b) => b.score - a.score);

    logger.info(
      `Signal priority queue: ${withIntel.map(s => `${s.decision.signal.symbol}:${s.score.toFixed(2)}(intel=${s.intelligenceScore})`).join(', ')}`,
      'signal-prioritizer'
    );

    return withIntel;
  }

  async _scoreSignal(signal, userId) {
    let score = 0;

    // Component 1: Strategy quality (win_rate × avg_r_multiple)
    if (signal.strategy) {
      const scorecard = await db.query(
        'SELECT win_rate, avg_r_multiple, profit_factor FROM strategy_scorecard WHERE user_id = $1 AND strategy = $2',
        [userId, signal.strategy]
      );

      if (scorecard.rows.length > 0) {
        const sc = scorecard.rows[0];
        const winRate = parseFloat(sc.win_rate) || 0;
        const avgR = parseFloat(sc.avg_r_multiple) || 1;
        score += winRate * Math.max(avgR, 0.5) * 10;
      } else {
        score += 5;
      }
    }

    // Component 2: Delta bonus — higher absolute delta = stronger directional conviction
    if (signal.delta) {
      const absDelta = Math.abs(parseFloat(signal.delta));
      score += absDelta * 3;
    }

    // Component 3: DTE preference — sweet spot is 21-45 DTE for options
    if (signal.expiration) {
      const dte = Math.ceil((new Date(signal.expiration) - Date.now()) / (1000 * 60 * 60 * 24));
      if (dte >= 21 && dte <= 45) {
        score += 2;
      } else if (dte >= 7 && dte <= 60) {
        score += 1;
      } else if (dte <= 0) {
        score -= 2;
      }
    }

    // Component 4: Indicator score passthrough (if provided by the indicator)
    if (signal.score) {
      score += parseFloat(signal.score) * 0.5;
    }

    return Math.round(score * 100) / 100;
  }

  /**
   * Merge the conviction score from the trade decision engine into prioritization.
   * Higher conviction trades get priority when position slots are limited.
   */
  incorporateIntelligence(scoredDecisions) {
    return scoredDecisions.map((item) => {
      const conviction = item.decision?.convictionScore ?? item.decision?.intelligenceScore ?? 0;
      const convictionBonus = (conviction - 70) * 0.2; // 0 at 70, +4 at 90, +6 at 100
      return {
        ...item,
        score: (item.score || 0) + convictionBonus,
        intelligenceScore: conviction,
      };
    });
  }

  async _getConfig(userId) {
    const result = await db.query(
      'SELECT * FROM sim_intelligence_config WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || {};
  }
}

module.exports = new SignalPrioritizer();
