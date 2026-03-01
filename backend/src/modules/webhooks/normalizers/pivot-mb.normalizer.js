'use strict';

const REQUIRED_FIELDS = ['symbol', 'side', 'entry_price', 'stop_price', 'timestamp'];

function validate(payload) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (payload[field] == null || payload[field] === '') {
      errors.push(`Missing ${field}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function normalize(payload) {
  const side = String(payload.side).toUpperCase();
  const isLong = side === 'LONG' || side === 'BUY';
  const direction = isLong ? 'long' : 'short';
  const action = isLong ? 'BUY' : 'SELL';

  return {
    source: 'PIVOT_MB',
    symbol: payload.symbol.toUpperCase(),
    direction,
    action,
    timeframe: payload.timeframe || '15',
    timestamp: payload.timestamp,
    entry: payload.entry_price,
    stop: payload.stop_price,
    targets: payload.targets || [],
    score: payload.confluence_score || 0,
    confidence: payload.confluence_score || 0,
    strategy: 'pivot_motherbar',
    indicatorMeta: {
      trigger: payload.trigger,
      emaAlignment: payload.ema_alignment_score,
      atrPercentile: payload.atr_percentile,
      pivotPosition: payload.pivot_position,
      motherBar: payload.mother_bar,
    },
  };
}

module.exports = { validate, normalize };
