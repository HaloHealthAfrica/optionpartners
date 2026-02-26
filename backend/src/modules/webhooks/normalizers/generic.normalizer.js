'use strict';

const { extractDirectionCandidate } = require('../indicator-detector');

/**
 * Generic/UNKNOWN normalizer — fallback for any TradingView webhook
 * that doesn't match a known indicator pattern.
 *
 * Uses the full extractDirectionCandidate() chain (13+ field paths).
 */
function normalize(payload) {
  const symbol = (payload.ticker || payload.symbol || '').toUpperCase();
  const timeframe = payload.timeframe || null;
  const timestamp = payload.timestamp || payload.time || null;

  const direction = extractDirectionCandidate(payload);
  const action = payload.action || payload.order_action || null;
  const normalizedAction = action
    ? action.toUpperCase()
    : direction === 'long' ? 'BUY' : direction === 'short' ? 'SELL' : null;

  return {
    source: 'UNKNOWN',
    symbol,
    direction,
    action: normalizedAction === 'CLOSE' ? 'CLOSE' : normalizedAction,
    timeframe,
    timestamp,
    entry: parseFloat(payload.limit_price || payload.entry) || null,
    stop: parseFloat(payload.stop_loss || payload.stop) || null,
    targets: parseFloat(payload.take_profit || payload.target)
      ? [parseFloat(payload.take_profit || payload.target)]
      : [],
    score: null,
    confidence: null,
    strategy: payload.strategy || payload.alert_name || 'UNKNOWN',
    indicatorMeta: {
      originalAction: action,
      alertName: payload.alert_name || null,
    },
  };
}

function validate(payload) {
  const errors = [];
  if (!payload.ticker && !payload.symbol) errors.push('Missing ticker/symbol');
  return { valid: errors.length === 0, errors };
}

module.exports = { normalize, validate };
