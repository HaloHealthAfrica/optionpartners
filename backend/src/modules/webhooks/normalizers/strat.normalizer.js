'use strict';

const { normalizeDirection } = require('../indicator-detector');

/**
 * STRAT normalizer — Strat V6 Full.
 *
 * Direction chain: signal.side → trend
 * Provides entry/target/stop levels and composite score.
 */
function normalize(payload) {
  const symbol = (payload.ticker || payload.symbol || '').toUpperCase();
  const timeframe = payload.timeframe || null;
  const timestamp = payload.timestamp || null;

  const dirRaw = payload.signal?.side ?? payload.trend ?? null;
  const direction = normalizeDirection(dirRaw);

  const entry = parseFloat(payload.entry) || null;
  const stop = parseFloat(payload.stop) || null;
  const target = parseFloat(payload.target) || null;
  const reversalLevel = parseFloat(payload.reversal_level ?? payload.reversalLevel) || null;

  return {
    source: 'STRAT',
    symbol,
    direction,
    action: direction === 'long' ? 'BUY' : direction === 'short' ? 'SELL' : null,
    timeframe,
    timestamp,
    entry,
    stop,
    targets: target ? [target] : [],
    score: typeof payload.score === 'number' ? payload.score : null,
    confidence: null,
    strategy: payload.setup || payload.setupType || payload.setup_type || 'STRAT',
    indicatorMeta: {
      engine: payload.journal?.engine,
      signalSide: payload.signal?.side || null,
      trend: payload.trend || null,
      setup: payload.setup || payload.setupType || payload.setup_type || null,
      components: Array.isArray(payload.components) ? payload.components : [],
      reversalLevel,
      optionsSuggestion: payload.options_suggestion || payload.optionsPlay || null,
      conditionText: payload.condition_text || payload.condition || null,
    },
  };
}

function validate(payload) {
  const errors = [];
  if (!payload.ticker && !payload.symbol) errors.push('Missing ticker/symbol');
  if (payload.journal?.engine !== 'STRAT_V6_FULL') errors.push('journal.engine must be STRAT_V6_FULL');

  const hasDirection = payload.signal?.side || payload.trend;
  if (!hasDirection) errors.push('No direction source (signal.side or trend)');

  return { valid: errors.length === 0, errors };
}

module.exports = { normalize, validate };
