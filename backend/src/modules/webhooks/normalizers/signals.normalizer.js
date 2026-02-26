'use strict';

const { normalizeDirection } = require('../indicator-detector');

/**
 * SIGNALS normalizer — Ultimate Options Strategy v3.0.
 *
 * The richest indicator: composite AI-scored signal with full entry/risk/target
 * levels, EMA/RSI/MACD trend data, multi-timeframe context, VWAP/PMH/PML
 * market context, score breakdown by component, and named pattern/setup.
 */
function normalize(payload) {
  const symbol = (payload.ticker || payload.instrument?.ticker || payload.instrument?.symbol || '').toUpperCase();
  const timeframe = payload.timeframe || payload.signal?.timeframe || null;
  const timestamp = payload.timestamp || payload.signal?.timestamp || null;

  const dirRaw = payload.direction ?? payload.signal?.type ?? payload.signal?.side ?? payload.trend ?? null;
  const direction = normalizeDirection(dirRaw);

  const entryObj = payload.entry || {};
  const riskObj = payload.risk || {};
  const entryPrice = parseFloat(entryObj.price ?? entryObj.entry_price ?? payload.current_price ?? payload.price) || null;
  const stopLoss = parseFloat(entryObj.stop_loss ?? riskObj.stop_loss) || null;

  const targets = [];
  const t1 = parseFloat(entryObj.target_1 ?? riskObj.target_1);
  const t2 = parseFloat(entryObj.target_2 ?? riskObj.target_2);
  if (!isNaN(t1)) targets.push(t1);
  if (!isNaN(t2)) targets.push(t2);

  const totalScore = payload.score_breakdown?.total ?? payload.score ?? null;
  const confidence = payload.confidence ?? null;

  return {
    source: 'SIGNALS',
    symbol,
    direction,
    action: direction === 'long' ? 'BUY' : direction === 'short' ? 'SELL' : null,
    timeframe,
    timestamp,
    entry: entryPrice,
    stop: stopLoss,
    targets,
    score: totalScore,
    confidence,
    strategy: payload.pattern || payload.setup || 'SIGNALS',
    indicatorMeta: {
      signalId: payload.signal_id || null,
      version: payload.version || null,
      quality: payload.signal?.quality || null,
      aiScore: payload.signal?.ai_score || null,
      barTime: payload.signal?.bar_time || null,

      risk: riskObj,
      marketContext: payload.market_context || null,
      trendData: payload.trend_data || null,
      mtfContext: payload.mtf_context || null,

      scoreBreakdown: payload.score_breakdown || null,
      components: Array.isArray(payload.components) ? payload.components : [],
      timeContext: payload.time_context || null,

      exchange: payload.exchange || payload.instrument?.exchange || null,
      session: payload.market_session || payload.session || null,
      stopReason: entryObj.stop_reason || null,
    },
  };
}

function validate(payload) {
  const errors = [];
  const symbol = payload.ticker || payload.instrument?.ticker || payload.instrument?.symbol;
  if (!symbol) errors.push('Missing ticker/symbol');

  if (!payload.signal || typeof payload.signal !== 'object') errors.push('Missing signal object');
  if (payload.score === undefined || typeof payload.score !== 'number') errors.push('Missing or invalid score (must be number)');
  if (!payload.trend) errors.push('Missing trend field');

  const hasDirection = payload.direction || payload.signal?.type || payload.signal?.side || payload.trend;
  if (!hasDirection) errors.push('No direction source');

  return { valid: errors.length === 0, errors };
}

module.exports = { normalize, validate };
