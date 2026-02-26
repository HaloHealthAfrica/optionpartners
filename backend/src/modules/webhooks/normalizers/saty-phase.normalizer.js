'use strict';

const { normalizeDirection } = require('../indicator-detector');

/**
 * SATY_PHASE normalizer — Satyland Phase Oscillator.
 *
 * Direction chain: regime_context.local_bias → execution_guidance.bias
 *   → event.phase_name (MARKUP=long, MARKDOWN=short)
 */
function normalize(payload) {
  const symbol = (payload.ticker || payload.symbol || '').toUpperCase();
  const timeframe = payload.timeframe || null;
  const timestamp = payload.timestamp || null;

  const dirRaw =
    payload.regime_context?.local_bias ??
    payload.execution_guidance?.bias ??
    payload.event?.phase_name ??
    null;

  const direction = normalizeDirection(dirRaw);

  return {
    source: 'SATY_PHASE',
    symbol,
    direction,
    action: direction === 'long' ? 'BUY' : direction === 'short' ? 'SELL' : null,
    timeframe,
    timestamp,
    entry: null,
    stop: null,
    targets: [],
    score: null,
    confidence: null,
    strategy: 'SATY_PHASE',
    indicatorMeta: {
      engine: payload.meta?.engine,
      metaSource: payload.meta?.source,
      localBias: payload.regime_context?.local_bias || null,
      executionBias: payload.execution_guidance?.bias || null,
      phaseName: payload.event?.phase_name || null,
    },
  };
}

function validate(payload) {
  const errors = [];
  if (!payload.ticker && !payload.symbol) errors.push('Missing ticker/symbol');
  if (payload.meta?.engine !== 'SATY_PO') errors.push('meta.engine must be SATY_PO');

  const hasDirection =
    payload.regime_context?.local_bias ||
    payload.execution_guidance?.bias ||
    payload.event?.phase_name;
  if (!hasDirection) errors.push('No direction source (regime_context.local_bias, execution_guidance.bias, or event.phase_name)');

  return { valid: errors.length === 0, errors };
}

module.exports = { normalize, validate };
