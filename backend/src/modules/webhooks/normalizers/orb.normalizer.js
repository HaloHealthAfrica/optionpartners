'use strict';

const { normalizeDirection } = require('../indicator-detector');

/**
 * ORB normalizer — Opening Range Breakout + variants (Stretch, BHCH, EMA).
 *
 * Direction: action (BUY=long, SELL=short) or side.
 * Provides entry and stop levels.
 */
function normalize(payload) {
  const symbol = (payload.ticker || payload.symbol || '').toUpperCase();
  const timeframe = payload.timeframe || null;
  const timestamp = payload.timestamp || null;

  const dirRaw = payload.side ?? payload.action ?? null;
  const direction = normalizeDirection(dirRaw);

  return {
    source: 'ORB',
    symbol,
    direction,
    action: direction === 'long' ? 'BUY' : direction === 'short' ? 'SELL' : null,
    timeframe,
    timestamp,
    entry: parseFloat(payload.entry) || null,
    stop: parseFloat(payload.stop) || null,
    targets: [],
    score: null,
    confidence: null,
    strategy: payload.indicator || 'ORB',
    indicatorMeta: {
      indicator: payload.indicator || null,
      originalAction: payload.action || null,
      originalSide: payload.side || null,
    },
  };
}

function validate(payload) {
  const errors = [];
  if (!payload.ticker && !payload.symbol) errors.push('Missing ticker/symbol');
  if (!payload.indicator) errors.push('Missing indicator field');

  const hasDirection = payload.action || payload.side;
  if (!hasDirection) errors.push('Missing action or side');

  return { valid: errors.length === 0, errors };
}

module.exports = { normalize, validate };
