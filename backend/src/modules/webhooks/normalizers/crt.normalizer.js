'use strict';

const { normalizeDirection } = require('../indicator-detector');

/**
 * CRT (Candle Range Theory + Fib + Strat Confluence Engine V3) normalizer.
 *
 * TradingView indicator sends enriched payload with:
 * - signal_id, symbol, direction (LONG/SHORT), option_type (call/put)
 * - entry, stop_loss, take_profit1/2/3
 * - strike, dte_suggestion, risk_r, atr
 * - score, trigger, sweep (confluence metadata)
 */
function validate(payload) {
  const errors = [];
  const symbol = (payload.symbol || '').toUpperCase();

  if (!symbol) errors.push('Missing symbol');
  if (!payload.signal_id) errors.push('Missing signal_id (required for deduplication)');
  const dir = (payload.direction || '').toUpperCase();
  if (dir !== 'LONG' && dir !== 'SHORT') errors.push('Missing or invalid direction (LONG/SHORT)');
  const optType = (payload.option_type || '').toLowerCase();
  if (optType !== 'call' && optType !== 'put') errors.push('Missing or invalid option_type (call/put)');
  if (typeof payload.entry !== 'number' && !payload.entry) errors.push('Missing entry price');
  if (typeof payload.stop_loss !== 'number' && !payload.stop_loss) errors.push('Missing stop_loss');
  if (!payload.strike && payload.strike !== 0) errors.push('Missing strike');

  return { valid: errors.length === 0, errors };
}

function normalize(payload) {
  const symbol = (payload.symbol || '').toUpperCase();
  const direction = (payload.direction || '').toUpperCase() === 'LONG' ? 'long' : 'short';
  const action = direction === 'long' ? 'BUY' : 'SELL';

  const entry = parseFloat(payload.entry) || null;
  const stop = parseFloat(payload.stop_loss) || null;
  const targets = [];
  const tp1 = parseFloat(payload.take_profit1);
  const tp2 = parseFloat(payload.take_profit2);
  const tp3 = parseFloat(payload.take_profit3);
  if (!isNaN(tp1)) targets.push(tp1);
  if (!isNaN(tp2)) targets.push(tp2);
  if (!isNaN(tp3)) targets.push(tp3);

  const score = typeof payload.score === 'number' ? payload.score : (parseInt(payload.score, 10) || 0);
  const confidence = score;

  return {
    source: 'CRT',
    symbol,
    direction,
    action,
    timeframe: payload.timeframe || null,
    timestamp: payload.timestamp || null,
    entry,
    stop,
    targets,
    score,
    confidence,
    strategy: 'crt_confluence',
    indicatorMeta: {
      signal_id: payload.signal_id || null,
      option_type: (payload.option_type || '').toLowerCase() || null,
      strike: parseFloat(payload.strike) || null,
      dte_suggestion: parseInt(payload.dte_suggestion, 10) || null,
      risk_r: parseFloat(payload.risk_r) || null,
      atr: parseFloat(payload.atr) || null,
      trigger: payload.trigger || null,
      sweep: payload.sweep || null,
      take_profit1: !isNaN(tp1) ? tp1 : null,
      take_profit2: !isNaN(tp2) ? tp2 : null,
      take_profit3: !isNaN(tp3) ? tp3 : null,
    },
  };
}

module.exports = { validate, normalize };
