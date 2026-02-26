'use strict';

const { normalizeDirection } = require('../indicator-detector');

const KNOWN_TIMEFRAME_KEYS = ['3m', '5m', '15m', '30m', '1h', '4h', '1w', '1M'];

/**
 * TREND normalizer — Multi-Timeframe Trend Dots.
 *
 * Direction: bias field.
 * Provides per-timeframe trend data, alignment scores, and trigger info.
 */
function normalize(payload) {
  const symbol = (payload.ticker || payload.symbol || '').toUpperCase();
  const timeframe = payload.timeframe || null;
  const timestamp = payload.timestamp || null;

  const direction = normalizeDirection(payload.bias);

  const tfData = payload.timeframes || {};
  let bullishCount = 0;
  let bearishCount = 0;
  const changedTimeframes = [];

  for (const key of KNOWN_TIMEFRAME_KEYS) {
    const tf = tfData[key];
    if (!tf) continue;
    if (tf.dir === 'bullish') bullishCount++;
    else if (tf.dir === 'bearish') bearishCount++;
    if (tf.chg) changedTimeframes.push(key);
  }

  const alignmentScore = payload.alignment_score ??
    (bullishCount + bearishCount > 0
      ? Math.round((Math.max(bullishCount, bearishCount) / (bullishCount + bearishCount)) * 100)
      : null);

  return {
    source: 'TREND',
    symbol,
    direction,
    action: direction === 'long' ? 'BUY' : direction === 'short' ? 'SELL' : null,
    timeframe,
    timestamp,
    entry: parseFloat(payload.price ?? payload.current_price) || null,
    stop: null,
    targets: [],
    score: alignmentScore,
    confidence: alignmentScore,
    strategy: 'TREND_DOTS',
    indicatorMeta: {
      bias: payload.bias || null,
      event: payload.event || null,
      triggerTimeframe: payload.trigger_timeframe || null,
      changedTimeframes,
      bullishCount: payload.bullish_count ?? bullishCount,
      bearishCount: payload.bearish_count ?? bearishCount,
      alignmentScore,
      timeframes: tfData,
      exchange: payload.exchange || null,
      meta: payload.meta || null,
    },
  };
}

function validate(payload) {
  const errors = [];
  if (!payload.ticker && !payload.symbol) errors.push('Missing ticker/symbol');
  if (!payload.bias) errors.push('Missing bias field');
  if (!payload.timeframes || typeof payload.timeframes !== 'object') {
    errors.push('Missing or invalid timeframes object');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { normalize, validate, KNOWN_TIMEFRAME_KEYS };
