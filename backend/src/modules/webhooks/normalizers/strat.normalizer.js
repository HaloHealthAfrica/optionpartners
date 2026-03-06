'use strict';

const { normalizeDirection, STRAT_PLAN_EVENTS } = require('../indicator-detector');

/**
 * STRAT normalizer — handles both legacy Strat V6 and Plan Engine v2.
 *
 * V1 (legacy): flat payload with entry/target/stop, signal.side, journal.engine
 * V2 (plan):   structured payload with setup.*, plan.*, meta.*, event lifecycle
 *
 * Direction chain:
 *   V1: signal.side → trend
 *   V2: setup.direction → setup.bias
 */

const PLAN_EVENT_SET = STRAT_PLAN_EVENTS;

function _isV2(payload) {
  const metaSystem = payload.meta?.system || '';
  if (metaSystem.includes('Strat Plan Engine')) return true;
  const event = (payload.event || '').toUpperCase();
  return PLAN_EVENT_SET.has(event) && payload.setup && typeof payload.setup === 'object';
}

function _isAdaptive(payload) {
  const metaSystem = payload.meta?.system || '';
  return metaSystem.includes('Adaptive Strat');
}

/**
 * Derive confidence from pattern quality when no explicit score is provided.
 * Maps the Strat methodology hierarchy to confidence values.
 */
function _deriveV2Confidence(payload) {
  const kind = (payload.setup?.pattern_kind || '').toUpperCase();
  const continuity = payload.setup?.continuity;

  if (kind === 'CONTINUATION') return continuity ? 85 : 70;
  if (kind === 'REVERSAL')     return continuity ? 75 : 55;
  if (kind === 'REVSTRAT')     return continuity ? 65 : 50;

  return continuity ? 75 : 65;
}

function normalize(payload) {
  if (_isAdaptive(payload)) return _normalizeAdaptive(payload);

  const v2 = _isV2(payload);

  const symbol = v2
    ? (payload.meta?.symbol || '').toUpperCase()
    : (payload.ticker || payload.symbol || '').toUpperCase();

  const timestamp = v2
    ? (payload.meta?.ts || null)
    : (payload.timestamp || null);

  // Direction
  const dirRaw = v2
    ? (payload.setup?.direction ?? payload.setup?.bias ?? null)
    : (payload.signal?.side ?? payload.trend ?? null);
  const direction = normalizeDirection(dirRaw);

  // Levels
  let entry, stop, targets;
  if (v2) {
    entry = parseFloat(payload.plan?.entry) || null;
    stop = parseFloat(payload.plan?.stop) || null;
    const t1 = parseFloat(payload.plan?.target1) || null;
    const t2 = parseFloat(payload.plan?.target2) || null;
    targets = [t1, t2].filter(Boolean);
  } else {
    entry = parseFloat(payload.entry) || null;
    stop = parseFloat(payload.stop) || null;
    const target = parseFloat(payload.target) || null;
    targets = target ? [target] : [];
  }

  // Action: only TRIGGERED / REVERSAL_IN_FORCE are trade triggers in V2
  let action = direction === 'long' ? 'BUY' : direction === 'short' ? 'SELL' : null;
  if (v2) {
    const event = (payload.event || '').toUpperCase();
    if (event !== 'TRIGGERED' && event !== 'REVERSAL_IN_FORCE') {
      action = null;
    }
  }

  // Confidence / score
  let confidence, rawScore;
  if (v2) {
    rawScore = null;
    confidence = _deriveV2Confidence(payload);
  } else {
    rawScore = typeof payload.score === 'number'
      ? payload.score
      : (typeof payload.signal?.ai_score === 'number' ? payload.signal.ai_score : null);
    confidence = null;
    if (rawScore != null) {
      confidence = rawScore <= 10
        ? Math.min(100, Math.round(rawScore * 10))
        : Math.min(100, Math.round(rawScore));
    }
    if (confidence == null && entry && targets.length && stop) {
      confidence = 75;
    }
  }

  // Strategy / setup name
  let strategyName;
  if (v2) {
    strategyName = payload.setup?.pattern || 'STRAT_PLAN';
  } else {
    const setup = payload.setup || payload.setupType || payload.setup_type || null;
    const components = Array.isArray(payload.components) ? payload.components : [];
    strategyName = setup
      || (components.includes('STRAT_SETUP') ? '2-1-2 Rev' : null)
      || 'STRAT';
  }

  // Timeframe
  const timeframe = v2
    ? (payload.setup?.htf || null)
    : (payload.timeframe || null);

  // ATR
  const atr = v2
    ? (parseFloat(payload.plan?.atr) || null)
    : null;

  // Reversal level
  const reversalLevel = v2
    ? null
    : (parseFloat(payload.reversal_level ?? payload.reversalLevel) || null);

  // Build indicator metadata
  let indicatorMeta;
  if (v2) {
    indicatorMeta = {
      engine: payload.meta?.system || null,
      planId: payload.plan_id || null,
      event: payload.event || null,
      pattern: payload.setup?.pattern || null,
      patternKind: payload.setup?.pattern_kind || null,
      direction: payload.setup?.direction || null,
      bias: payload.setup?.bias || null,
      continuity: payload.setup?.continuity ?? null,
      htf: payload.setup?.htf || null,
      ltf: payload.setup?.ltf || null,
      ctf: payload.setup?.ctf || null,
      htfCandle: payload.setup?.htf_candle || null,
      htfCandlePrev: payload.setup?.htf_candle_prev || null,
      ctfCandle: payload.setup?.ctf_candle || null,
      atr,
      openCondition: payload.plan?.open_condition || null,
      expiryLtfBars: payload.plan?.expiry_ltf_bars || null,
      market: payload.market || null,
      reversalLevel: null,
      optionsSuggestion: null,
      conditionText: payload.plan?.open_condition?.type || null,
    };
  } else {
    indicatorMeta = {
      engine: payload.journal?.engine || null,
      signalSide: payload.signal?.side || null,
      trend: payload.trend || null,
      setup: payload.setup || payload.setupType || payload.setup_type || null,
      components: Array.isArray(payload.components) ? payload.components : [],
      reversalLevel,
      optionsSuggestion: payload.options_suggestion || payload.optionsPlay || null,
      conditionText: payload.condition_text || payload.condition || null,
    };
  }

  return {
    source: 'STRAT',
    symbol,
    direction,
    action,
    timeframe,
    timestamp,
    entry,
    stop,
    targets,
    score: rawScore,
    confidence,
    strategy: strategyName,
    indicatorMeta,
  };
}

/**
 * Normalize Adaptive Strat v6 payloads.
 * These use meta.ticker, signal.pattern for setup, strat_details for FTFC,
 * and scores.intraday/swing for confidence.
 */
function _normalizeAdaptive(payload) {
  const symbol = (payload.meta?.ticker || '').toUpperCase();
  const timestamp = payload.meta?.timestamp || null;

  const pattern = payload.signal?.pattern || 'STRAT';
  const patternLower = pattern.toLowerCase();
  const direction = normalizeDirection(
    patternLower.includes('bull') ? 'long'
    : patternLower.includes('bear') ? 'short'
    : null
  );

  const entry = parseFloat(payload.signal?.price) || null;
  const target = parseFloat(payload.signal?.target) || null;
  const targets = target ? [target] : [];
  const stop = null;

  const scores = payload.scores || {};
  const bestScore = Math.max(scores.intraday || 0, scores.swing || 0, scores.leaps || 0);
  const confidence = bestScore > 0 ? Math.min(100, bestScore) : null;
  const action = direction === 'long' ? 'BUY' : direction === 'short' ? 'SELL' : null;

  const indicatorMeta = {
    engine: payload.meta?.system || 'Adaptive Strat',
    pattern,
    direction,
    strat_details: payload.strat_details || null,
    ftfc: payload.strat_details?.ftfc_summary || null,
    daily_candle: payload.strat_details?.daily_candle || null,
    scores,
    liquidity_map: payload.liquidity_map || null,
    orb_status: payload.signal?.orb_status || null,
  };

  return {
    source: 'STRAT',
    symbol,
    direction,
    action,
    timeframe: null,
    timestamp,
    entry,
    stop,
    targets,
    score: bestScore || null,
    confidence,
    strategy: `STRAT_ADAPTIVE_${pattern.replace(/\s+/g, '_').toUpperCase()}`,
    indicatorMeta,
  };
}

function validate(payload) {
  const errors = [];

  if (_isAdaptive(payload)) {
    if (!payload.meta?.ticker) errors.push('Missing meta.ticker');
    if (!payload.signal || typeof payload.signal !== 'object') errors.push('Missing signal object');
    return { valid: errors.length === 0, errors };
  }

  const v2 = _isV2(payload);

  if (v2) {
    if (!payload.meta?.symbol) errors.push('Missing meta.symbol');
    if (!payload.setup || typeof payload.setup !== 'object') errors.push('Missing setup object');
    const hasDir = payload.setup?.direction || payload.setup?.bias;
    if (!hasDir) errors.push('No direction source (setup.direction or setup.bias)');
  } else {
    if (!payload.ticker && !payload.symbol) errors.push('Missing ticker/symbol');

    const engine = payload.journal?.engine;
    const isStratEngine = engine === 'STRAT_V6_FULL' || engine === 'STRAT';
    const hasStratComponent = Array.isArray(payload.components) && payload.components.some(c =>
      c === 'STRAT_SETUP' || c === 'HTF_IGNITION' || c === 'BIAS_SHIFT'
    );
    const hasStratLevels = typeof payload.entry === 'number'
      && typeof payload.target === 'number'
      && typeof payload.stop === 'number';

    if (!isStratEngine && !hasStratComponent && !hasStratLevels) {
      errors.push('Not a STRAT webhook: needs journal.engine, STRAT components, or entry/target/stop levels');
    }

    const hasDirection = payload.signal?.side || payload.trend;
    if (!hasDirection) errors.push('No direction source (signal.side or trend)');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { normalize, validate, _isV2, _isAdaptive };
