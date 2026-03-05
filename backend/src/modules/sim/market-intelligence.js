'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');

/**
 * Market Intelligence Layer
 *
 * Cross-references live market data (options flow, price ticks, chain snapshots)
 * with incoming trading signals to produce a composite intelligence verdict.
 *
 * Pipeline position: runs inside decision-router after adaptive guards,
 * before options construction.
 *
 * Sub-checks (each independently toggleable):
 *  1. Signal Confluence   — do multiple indicators agree on this symbol/direction?
 *  2. Options Flow Align  — does institutional flow support the signal direction?
 *  3. Confidence Gate     — is the indicator's self-reported confidence above threshold?
 *  4. Price Action Valid   — does current price support the trade thesis?
 *
 * Returns a composite result with per-check details and a numeric
 * intelligence_score that feeds into signal prioritization.
 */

/**
 * @typedef {Object} IntelligenceResult
 * @property {boolean} allowed
 * @property {string} [reason]
 * @property {number} intelligenceScore   — composite score (0-100) for prioritization
 * @property {Object} checks              — per-check results
 */

class MarketIntelligence {
  /**
   * Run all market intelligence checks against a signal.
   *
   * @param {Object} signal - Mapped SimSignal
   * @param {string} userId
   * @returns {Promise<IntelligenceResult>}
   */
  async evaluate(signal, userId) {
    if (signal.action === 'CLOSE') {
      return { allowed: true, intelligenceScore: 0, checks: {} };
    }

    const config = await this._getConfig(userId);

    const checks = {};
    let totalScore = 50; // baseline
    const rejections = [];

    // 1. Signal Confluence
    if (config.enable_confluence !== false) {
      const confluence = await this._checkConfluence(signal, userId, config);
      checks.confluence = confluence;
      totalScore += confluence.scoreAdjustment;
      if (!confluence.passed && config.require_confluence === true) {
        rejections.push(`CONFLUENCE: ${confluence.reason}`);
      }
    }

    // 2. Options Flow Alignment
    if (config.enable_flow_alignment !== false) {
      const flow = await this._checkFlowAlignment(signal, userId, config);
      checks.flowAlignment = flow;
      totalScore += flow.scoreAdjustment;
      if (!flow.passed && config.require_flow_alignment === true) {
        rejections.push(`FLOW_ALIGNMENT: ${flow.reason}`);
      }
    }

    // 3. Confidence Gate
    if (config.enable_confidence_gate !== false) {
      const confidence = this._checkConfidenceGate(signal, config);
      checks.confidenceGate = confidence;
      totalScore += confidence.scoreAdjustment;
      if (!confidence.passed) {
        rejections.push(`CONFIDENCE_GATE: ${confidence.reason}`);
      }
    }

    // 4. Price Action Validation
    if (config.enable_price_validation !== false) {
      const priceAction = await this._checkPriceAction(signal, userId, config);
      checks.priceAction = priceAction;
      totalScore += priceAction.scoreAdjustment;
      if (!priceAction.passed && config.require_price_validation === true) {
        rejections.push(`PRICE_VALIDATION: ${priceAction.reason}`);
      }
    }

    const clampedScore = Math.max(0, Math.min(100, totalScore));

    // Minimum intelligence score gate
    const minScore = config.min_intelligence_score || 0;
    if (minScore > 0 && clampedScore < minScore) {
      rejections.push(
        `Intelligence score ${clampedScore.toFixed(1)} below minimum ${minScore}`
      );
    }

    if (rejections.length > 0) {
      logger.info(
        `[MARKET_INTEL] ${signal.symbol} REJECTED: ${rejections.join('; ')} (score=${clampedScore.toFixed(1)})`,
        'market-intelligence'
      );
      return {
        allowed: false,
        reason: rejections.join('; '),
        intelligenceScore: clampedScore,
        checks,
      };
    }

    logger.info(
      `[MARKET_INTEL] ${signal.symbol} ${signal.direction} score=${clampedScore.toFixed(1)} ` +
      `confluence=${checks.confluence?.confluenceCount || 'n/a'} ` +
      `flow=${checks.flowAlignment?.alignmentLabel || 'n/a'} ` +
      `confidence=${signal.confidence ?? 'n/a'}`,
      'market-intelligence'
    );

    return {
      allowed: true,
      intelligenceScore: clampedScore,
      checks,
    };
  }

  // ─── 1. Signal Confluence ───────────────────────────────────────────

  /**
   * Check for corroborating signals on the same symbol in the same direction
   * within a recent time window.
   */
  async _checkConfluence(signal, userId, config) {
    const windowMinutes = config.confluence_window_minutes || 30;
    const minConfluence = config.min_confluence_signals || 2;

    const result = await db.query(
      `SELECT raw_payload, source, received_at
       FROM webhook_events
       WHERE user_id = $1
         AND status IN ('RECEIVED', 'PROCESSED')
         AND received_at >= NOW() - INTERVAL '1 minute' * $2
       ORDER BY received_at DESC
       LIMIT 50`,
      [userId, windowMinutes]
    );

    let confluenceCount = 0;
    const corroboratingSources = [];

    for (const row of result.rows) {
      const payload = typeof row.raw_payload === 'string'
        ? JSON.parse(row.raw_payload) : row.raw_payload;

      const sym = (payload.ticker || payload.symbol || '').toUpperCase();
      if (sym !== signal.symbol) continue;

      const dir = this._extractDirection(payload);
      if (dir && dir === signal.direction) {
        confluenceCount++;
        const src = payload.meta?.indicatorSource
          || payload.event_type
          || row.source
          || 'unknown';
        if (!corroboratingSources.includes(src)) {
          corroboratingSources.push(src);
        }
      }
    }

    const passed = confluenceCount >= minConfluence;
    const scoreAdjustment = passed
      ? Math.min(confluenceCount * 4, 15)  // up to +15
      : (confluenceCount > 0 ? 2 : -5);   // partial credit or penalty

    return {
      passed,
      confluenceCount,
      corroboratingSources,
      windowMinutes,
      minRequired: minConfluence,
      scoreAdjustment,
      reason: passed
        ? `${confluenceCount} corroborating signals from [${corroboratingSources.join(', ')}]`
        : `Only ${confluenceCount} corroborating signal(s) in ${windowMinutes}min window (need ${minConfluence})`,
    };
  }

  // ─── 2. Options Flow Alignment ─────────────────────────────────────

  /**
   * Cross-reference recent unusual options flow for the signal's symbol.
   * Bullish flow + bullish signal = alignment bonus.
   * Bearish flow + bullish signal = contradiction penalty.
   */
  async _checkFlowAlignment(signal, userId, config) {
    const windowMinutes = config.flow_lookback_minutes || 60;
    const minPremium = config.flow_min_premium || 50000;

    const result = await db.query(
      `SELECT flow_type, strike, expiry, premium, size, sentiment, unusual
       FROM options_flow
       WHERE symbol = $1
         AND received_at >= NOW() - INTERVAL '1 minute' * $2
         AND (user_id = $3 OR user_id IS NULL)
       ORDER BY received_at DESC
       LIMIT 100`,
      [signal.symbol, windowMinutes, userId]
    );

    if (result.rows.length === 0) {
      return {
        passed: true,
        alignmentLabel: 'NO_DATA',
        flowCount: 0,
        scoreAdjustment: 0,
        reason: 'No recent options flow data available',
      };
    }

    let bullishWeight = 0;
    let bearishWeight = 0;
    let significantFlows = 0;

    for (const flow of result.rows) {
      const premium = parseFloat(flow.premium) || 0;
      const size = parseInt(flow.size, 10) || 0;
      const weight = flow.unusual ? 2 : 1;
      const premiumWeight = premium >= minPremium ? 1.5 : 1;

      const flowScore = size * weight * premiumWeight;

      const isBullish = this._isFlowBullish(flow);
      if (isBullish === true) {
        bullishWeight += flowScore;
      } else if (isBullish === false) {
        bearishWeight += flowScore;
      }

      if (premium >= minPremium || flow.unusual) {
        significantFlows++;
      }
    }

    const totalWeight = bullishWeight + bearishWeight;
    if (totalWeight === 0) {
      return {
        passed: true,
        alignmentLabel: 'NEUTRAL',
        flowCount: result.rows.length,
        significantFlows,
        scoreAdjustment: 0,
        reason: 'Options flow is neutral',
      };
    }

    const bullishRatio = bullishWeight / totalWeight;
    const signalIsBullish = signal.direction === 'long';

    const aligned = signalIsBullish ? bullishRatio >= 0.6 : bullishRatio <= 0.4;
    const contradicted = signalIsBullish ? bullishRatio <= 0.3 : bullishRatio >= 0.7;

    let alignmentLabel, scoreAdjustment;
    if (aligned) {
      alignmentLabel = 'ALIGNED';
      scoreAdjustment = Math.min(significantFlows * 3, 12);
    } else if (contradicted) {
      alignmentLabel = 'CONTRADICTED';
      scoreAdjustment = -10;
    } else {
      alignmentLabel = 'MIXED';
      scoreAdjustment = -2;
    }

    return {
      passed: !contradicted,
      alignmentLabel,
      flowCount: result.rows.length,
      significantFlows,
      bullishRatio: Math.round(bullishRatio * 100),
      scoreAdjustment,
      reason: contradicted
        ? `Flow contradicts signal: ${Math.round((1 - bullishRatio) * 100)}% bearish flow vs ${signal.direction} signal`
        : `Flow ${alignmentLabel.toLowerCase()}: ${Math.round(bullishRatio * 100)}% bullish (${significantFlows} significant flows)`,
    };
  }

  /**
   * Determine if an options flow record represents bullish or bearish sentiment.
   * @returns {boolean|null} true=bullish, false=bearish, null=indeterminate
   */
  _isFlowBullish(flow) {
    const sentiment = (flow.sentiment || '').toLowerCase();
    if (sentiment === 'bullish' || sentiment === 'bull') return true;
    if (sentiment === 'bearish' || sentiment === 'bear') return false;

    const type = (flow.flow_type || '').toLowerCase();
    if (type === 'call') return true;
    if (type === 'put') return false;

    return null;
  }

  // ─── 3. Confidence Gate ─────────────────────────────────────────────

  /**
   * Check if the signal's self-reported confidence meets the minimum threshold.
   * Signals without confidence are allowed through (not all indicators provide it).
   */
  _checkConfidenceGate(signal, config) {
    const minConfidence = config.min_signal_confidence || 0;

    if (minConfidence <= 0) {
      return {
        passed: true,
        signalConfidence: signal.confidence,
        scoreAdjustment: this._confidenceToScore(signal.confidence),
        reason: 'Confidence gate disabled',
      };
    }

    if (signal.confidence == null) {
      return {
        passed: true,
        signalConfidence: null,
        scoreAdjustment: 0,
        reason: 'No confidence value provided by indicator',
      };
    }

    const conf = parseFloat(signal.confidence);
    const passed = conf >= minConfidence;

    return {
      passed,
      signalConfidence: conf,
      minRequired: minConfidence,
      scoreAdjustment: this._confidenceToScore(conf),
      reason: passed
        ? `Confidence ${conf} meets minimum ${minConfidence}`
        : `Confidence ${conf} below minimum ${minConfidence}`,
    };
  }

  _confidenceToScore(confidence) {
    if (confidence == null) return 0;
    const c = parseFloat(confidence);
    if (c >= 80) return 10;
    if (c >= 60) return 5;
    if (c >= 40) return 0;
    if (c >= 20) return -5;
    return -10;
  }

  // ─── 4. Price Action Validation ─────────────────────────────────────

  /**
   * Validate that current price supports the trade thesis.
   * For longs: price shouldn't have already run away from entry.
   * For shorts: price shouldn't have already collapsed past the target.
   */
  async _checkPriceAction(signal, userId, config) {
    const maxSlippagePct = config.price_max_entry_slippage_pct || 0.02;

    const result = await db.query(
      `SELECT price, volume, high, low, open, updated_at
       FROM price_cache
       WHERE symbol = $1`,
      [signal.symbol]
    );

    if (result.rows.length === 0) {
      return {
        passed: true,
        scoreAdjustment: 0,
        reason: 'No cached price data available',
      };
    }

    const cached = result.rows[0];
    const currentPrice = parseFloat(cached.price);
    const entryPrice = signal.limitPrice || signal.midPrice || signal.askPrice;

    if (!entryPrice || !currentPrice) {
      return {
        passed: true,
        currentPrice,
        entryPrice,
        scoreAdjustment: 0,
        reason: 'Insufficient price data for validation',
      };
    }

    const priceDelta = (currentPrice - entryPrice) / entryPrice;
    const absDelta = Math.abs(priceDelta);
    const isLong = signal.direction === 'long';

    // For longs: price running up too far means chasing
    // For shorts: price dropping too far means chasing
    const isChasing = isLong ? priceDelta > maxSlippagePct : priceDelta < -maxSlippagePct;

    // For longs: price dropping significantly from entry may mean thesis is broken
    // For shorts: price rising significantly from entry may mean thesis is broken
    const thesisBroken = isLong
      ? priceDelta < -(maxSlippagePct * 2)
      : priceDelta > (maxSlippagePct * 2);

    let passed = true;
    let scoreAdjustment = 0;
    let reason;

    if (thesisBroken) {
      passed = false;
      scoreAdjustment = -15;
      reason = `Price has moved ${(absDelta * 100).toFixed(1)}% against the ${signal.direction} thesis (current=${currentPrice}, entry=${entryPrice})`;
    } else if (isChasing) {
      passed = false;
      scoreAdjustment = -8;
      reason = `Price already moved ${(priceDelta * 100).toFixed(1)}% in favor — chasing risk (current=${currentPrice}, entry=${entryPrice})`;
    } else {
      scoreAdjustment = absDelta < 0.005 ? 5 : 2;
      reason = `Price ${currentPrice} within ${(absDelta * 100).toFixed(2)}% of entry ${entryPrice}`;
    }

    // Intraday range context
    const high = parseFloat(cached.high);
    const low = parseFloat(cached.low);
    let rangeContext = null;
    if (high && low && high > low) {
      const rangePosition = (currentPrice - low) / (high - low);
      rangeContext = {
        high,
        low,
        rangePosition: Math.round(rangePosition * 100),
      };
      // Buying near the top or selling near the bottom is risky
      if (isLong && rangePosition > 0.90) {
        scoreAdjustment -= 3;
      } else if (!isLong && rangePosition < 0.10) {
        scoreAdjustment -= 3;
      }
    }

    return {
      passed,
      currentPrice,
      entryPrice,
      priceDeltaPct: Math.round(priceDelta * 10000) / 100,
      rangeContext,
      scoreAdjustment,
      reason,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  _extractDirection(payload) {
    const dir = payload.direction || payload.side || payload.bias || payload.trend;
    if (!dir) return null;
    const s = String(dir).toUpperCase().trim();
    if (['LONG', 'BUY', 'BULLISH', 'BULL', 'CALL'].includes(s)) return 'long';
    if (['SHORT', 'SELL', 'BEARISH', 'BEAR', 'PUT'].includes(s)) return 'short';
    return null;
  }

  async _getConfig(userId) {
    const result = await db.query(
      'SELECT * FROM sim_intelligence_config WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || {};
  }

  /**
   * Get a snapshot of the latest intelligence evaluation for a symbol.
   * Useful for the dashboard.
   */
  async getIntelligenceSnapshot(symbol, userId) {
    const [flowResult, priceResult, recentSignals] = await Promise.all([
      db.query(
        `SELECT flow_type, strike, premium, size, sentiment, unusual, received_at
         FROM options_flow
         WHERE symbol = $1 AND (user_id = $2 OR user_id IS NULL)
         ORDER BY received_at DESC LIMIT 20`,
        [symbol, userId]
      ),
      db.query('SELECT * FROM price_cache WHERE symbol = $1', [symbol]),
      db.query(
        `SELECT raw_payload, source, received_at
         FROM webhook_events
         WHERE user_id = $1 AND status IN ('RECEIVED', 'PROCESSED')
           AND received_at >= NOW() - INTERVAL '60 minutes'
         ORDER BY received_at DESC LIMIT 30`,
        [userId]
      ),
    ]);

    return {
      symbol,
      recentFlow: flowResult.rows,
      priceCache: priceResult.rows[0] || null,
      recentSignalCount: recentSignals.rows.filter(r => {
        const p = typeof r.raw_payload === 'string' ? JSON.parse(r.raw_payload) : r.raw_payload;
        return (p.ticker || p.symbol || '').toUpperCase() === symbol;
      }).length,
      generatedAt: new Date().toISOString(),
    };
  }
}

module.exports = new MarketIntelligence();
module.exports.MarketIntelligence = MarketIntelligence;
