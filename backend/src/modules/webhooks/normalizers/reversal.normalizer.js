'use strict';

const REVERSAL_SYMBOLS = new Set(['SPY', 'QQQ', 'IWM', 'IWN']);

/** EME: confidence >= 50 */
const EME_MIN_CONFIDENCE = parseInt(process.env.REVERSAL_EME_MIN_CONFIDENCE || '50', 10);
/** SPE: probability_score >= 65 */
const SPE_MIN_SCORE = parseInt(process.env.REVERSAL_SPE_MIN_SCORE || '65', 10);
/** Strat: confidence_score >= 70 */
const STRAT_MIN_CONFIDENCE = parseInt(process.env.REVERSAL_STRAT_MIN_CONFIDENCE || '70', 10);

function validate(payload) {
  const errors = [];
  const symbol = (payload.symbol || '').toUpperCase();

  if (!symbol) errors.push('Missing symbol');
  if (!REVERSAL_SYMBOLS.has(symbol)) {
    errors.push(`Symbol ${symbol} not in allowed list (SPY, QQQ, IWM, IWN)`);
  }

  const signalType = (payload.signal_type || '').toUpperCase();
  const signalVal = (payload.signal || '').toUpperCase();

  if (['EM_CALL_ZONE', 'EM_PUT_ZONE', 'EM_BREAKOUT'].includes(signalType)) {
    const conf = parseInt(payload.confidence, 10);
    if (isNaN(conf) || conf < EME_MIN_CONFIDENCE) {
      errors.push(`EME confidence must be >= ${EME_MIN_CONFIDENCE}`);
    }
    if (signalType === 'EM_BREAKOUT') {
      errors.push('EM_BREAKOUT (vol expansion) — skip per guide');
    }
  } else if (['PUT_SPREAD_FAVORABLE', 'CALL_SPREAD_FAVORABLE'].includes(signalVal)) {
    const score = parseFloat(payload.probability_score);
    if (isNaN(score) || score < SPE_MIN_SCORE) {
      errors.push(`SPE probability_score must be >= ${SPE_MIN_SCORE}`);
    }
  } else if (signalVal === 'STRAT_TRIGGER') {
    if (!payload.setup_id) errors.push('STRAT_TRIGGER requires setup_id');
    const conf = parseInt(payload.confidence_score, 10);
    if (isNaN(conf) || conf < STRAT_MIN_CONFIDENCE) {
      errors.push(`STRAT_TRIGGER confidence_score must be >= ${STRAT_MIN_CONFIDENCE}`);
    }
  } else {
    errors.push('Unknown Reversal signal type');
  }

  return { valid: errors.length === 0, errors };
}

function normalize(payload) {
  const symbol = (payload.symbol || '').toUpperCase();
  const signalType = (payload.signal_type || '').toUpperCase();
  const signalVal = (payload.signal || '').toUpperCase();
  const pattern = (payload.pattern || '').toUpperCase();

  let direction = null;
  let strategy = 'reversal';
  let score = 0;
  let confidence = 0;

  if (['EM_CALL_ZONE', 'EM_PUT_ZONE'].includes(signalType)) {
    direction = signalType === 'EM_CALL_ZONE' ? 'long' : 'short';
    strategy = 'reversal_eme';
    score = parseInt(payload.confidence, 10) || 0;
    confidence = score;
  } else if (['PUT_SPREAD_FAVORABLE', 'CALL_SPREAD_FAVORABLE'].includes(signalVal)) {
    // PUT_SPREAD_FAVORABLE = bearish → sell call spread
    // CALL_SPREAD_FAVORABLE = bullish → sell put spread
    direction = signalVal === 'CALL_SPREAD_FAVORABLE' ? 'long' : 'short';
    strategy = 'reversal_spe';
    score = parseFloat(payload.probability_score) || 0;
    confidence = score;
  } else if (signalVal === 'STRAT_TRIGGER') {
    if (pattern.includes('BULL')) direction = 'long';
    else if (pattern.includes('BEAR')) direction = 'short';
    strategy = 'reversal_strat';
    score = parseInt(payload.confidence_score, 10) || 0;
    confidence = score;
  }

  const action = direction ? (direction === 'long' ? 'BUY' : 'SELL') : null;

  return {
    source: 'REVERSAL',
    symbol,
    direction,
    action,
    timeframe: payload.timeframe || null,
    timestamp: payload.timestamp || null,
    entry: parseFloat(payload.price) || null,
    stop: null,
    targets: [],
    score,
    confidence,
    strategy,
    indicatorMeta: {
      signal_type: signalType || null,
      signal: signalVal || null,
      pattern: payload.pattern || null,
      setup_id: payload.setup_id || null,
      expected_move: parseFloat(payload.expected_move) || null,
      atr: parseFloat(payload.atr) || null,
      trigger_level: parseFloat(payload.trigger_level) || null,
      setup_low: parseFloat(payload.setup_low) || null,
    },
  };
}

module.exports = { validate, normalize };
