'use strict';

const { normalizeDirection } = require('../indicator-detector');

/**
 * MTF_BIAS normalizer — MTF Bias Engine V3.
 *
 * The most data-dense context signal: multi-timeframe bias consensus,
 * regime classification, key levels (VWAP/ORB/swings), bar trigger
 * patterns, liquidity sweeps, macro state, and risk invalidation.
 *
 * Direction: mtf.consensus.bias_consensus → macro.state.macro_class
 */
function normalize(payload) {
  const symbol = (payload.symbol || payload.ticker || '').toUpperCase();
  const timeframe = payload.chart_tf || null;
  const timestamp = payload.event_ts_ms || payload.timestamp || null;

  const consensus = payload.mtf?.consensus || {};
  const regime = payload.mtf?.regime || {};
  const macroState = payload.macro?.state || {};
  const trigger = payload.trigger || {};
  const levels = payload.levels || {};
  const intent = payload.intent || {};
  const riskCtx = payload.risk_context || {};
  const bar = payload.bar || {};
  const liquidity = payload.liquidity || {};
  const space = payload.space || {};

  const dirRaw = consensus.bias_consensus ?? macroState.macro_class ?? null;
  const direction = normalizeDirection(dirRaw);

  const entryPrice = parseFloat(bar.close ?? payload.price) || null;
  const stopLoss = parseFloat(riskCtx.invalidation?.level) || null;

  const targets = [];
  const measuredMove = parseFloat(macroState.macro_measured_move_target);
  if (!isNaN(measuredMove)) targets.push(measuredMove);

  const biasScore = consensus.bias_score ?? null;
  const confidenceScore = consensus.confidence_score != null
    ? Math.round(consensus.confidence_score * 100)
    : null;

  return {
    source: 'MTF_BIAS',
    symbol,
    direction,
    action: direction === 'long' ? 'BUY' : direction === 'short' ? 'SELL' : null,
    timeframe,
    timestamp,
    entry: entryPrice,
    stop: stopLoss,
    targets,
    score: biasScore,
    confidence: confidenceScore,
    strategy: trigger.pattern || 'MTF_BIAS',
    indicatorMeta: {
      eventType: payload.event_type || null,
      eventIdRaw: payload.event_id_raw || null,
      exchange: payload.exchange || null,
      session: payload.session || null,

      consensus,
      regime: {
        type: regime.type || null,
        chopScore: regime.chop_score ?? null,
        adx15m: regime.adx_15m ?? null,
        atrState15m: regime.atr_state_15m || null,
      },

      bar,
      trigger: {
        barType: trigger.bar_type || null,
        pattern: trigger.pattern || null,
        triggered: trigger.triggered ?? false,
      },

      levels: {
        vwap: levels.vwap || null,
        orb: levels.orb || null,
        swings: levels.swings || null,
      },

      liquidity,
      space,
      intent,
      riskContext: riskCtx,

      macroState,
      mtfTimeframes: payload.mtf?.timeframes || [],
      macroTimeframes: payload.macro?.timeframes || [],
    },
  };
}

function validate(payload) {
  const errors = [];
  if (!payload.symbol && !payload.ticker) errors.push('Missing symbol/ticker');
  if (payload.source !== 'MTF_BIAS_ENGINE_V3') errors.push('source must be MTF_BIAS_ENGINE_V3');
  if (!payload.event_id_raw) errors.push('Missing event_id_raw');

  const consensus = payload.mtf?.consensus;
  if (!consensus || !consensus.bias_consensus) {
    errors.push('Missing mtf.consensus.bias_consensus');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { normalize, validate };
