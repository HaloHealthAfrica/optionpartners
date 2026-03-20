'use strict';

/**
 * Indicator source detection and direction extraction.
 *
 * Detection priority (first match wins):
 *   Explicit event_type → SATY_PHASE → STRAT → MTF_BIAS → TREND → ORB
 *   → SIGNALS → OPTIONS_FLOW → PRICE_TICK → UNKNOWN
 */

const KNOWN_ORB_INDICATORS = ['ORB', 'Stretch', 'BHCH', 'EMA'];

const STRAT_PLAN_EVENTS = new Set([
  'PLAN_CREATED', 'IN_FORCE', 'TRIGGERED',
  'INVALIDATED', 'EXPIRED', 'REVERSAL_IN_FORCE',
]);

const MARKET_DATA_TYPES = ['OPTIONS_FLOW', 'PRICE_TICK', 'CHAIN_SNAPSHOT'];

const CONTEXT_SOURCES = ['MARKET_CONTEXT'];

/**
 * Identify which indicator or data type produced this webhook payload.
 * @param {Object} payload - Raw webhook payload
 * @returns {string} Source identifier
 */
function detectIndicatorSource(payload) {
  if (!payload || typeof payload !== 'object') return 'UNKNOWN';

  // Explicit event_type field takes priority (lets any payload self-identify)
  const explicitType = (payload.event_type || '').toUpperCase();
  if (MARKET_DATA_TYPES.includes(explicitType)) return explicitType;

  const metaSource = (payload.meta?.source || '').toUpperCase();
  const metaIndicator = (payload.meta?.indicator || '').toUpperCase();
  const metaEngine = payload.meta?.engine;
  const journalEngine = payload.journal?.engine;

  // Market Context Webhook — context/regime data, not a trade signal
  if (metaSource === 'MARKET_CONTEXT' || metaIndicator.includes('MARKET CONTEXT')) return 'MARKET_CONTEXT';

  if (metaEngine === 'SATY_PO') return 'SATY_PHASE';

  // STRAT via explicit journal.engine (definitive — this IS a STRAT-only webhook)
  if (journalEngine === 'STRAT_V6_FULL' || journalEngine === 'STRAT') return 'STRAT';

  // Strat Plan Engine v2 + Adaptive Strat v6 — structured plan lifecycle webhooks
  const metaSystem = (payload.meta?.system || '');
  if (metaSystem.includes('Strat Plan Engine') || metaSystem.includes('Adaptive Strat')) return 'STRAT';

  const planEvent = (payload.event || '').toUpperCase();
  if (STRAT_PLAN_EVENTS.has(planEvent) && payload.setup && typeof payload.setup === 'object') return 'STRAT';

  if (payload.source === 'MTF_BIAS_ENGINE_V3' && payload.event_id_raw) return 'MTF_BIAS';
  if (payload.timeframes && payload.bias && payload.ticker) return 'TREND';
  if (payload.indicator && KNOWN_ORB_INDICATORS.includes(payload.indicator)) return 'ORB';

  if (payload.source === 'SQUEEZE_PRO' || payload.source === 'SQZ_ULTRA_PRO') return 'SQUEEZE_PRO';

  // Fingerprint-based SQUEEZE_PRO detection: squeeze object or compression fields
  if (payload.squeeze && typeof payload.squeeze === 'object' && payload.ticker && payload.direction) return 'SQUEEZE_PRO';
  if (payload.compression_score != null && payload.ticker && payload.direction) return 'SQUEEZE_PRO';

  if (payload.source === 'PIVOT_MB' || payload.signal_type === 'PIVOT_MOTHERBAR') return 'PIVOT_MB';

  // CRT (Candle Range Theory + Fib + Strat Confluence Engine V3) — TradingView webhook
  // Fingerprint: signal_id, direction (LONG/SHORT), option_type (call/put), entry, stop_loss, take_profit1/2/3
  if (payload.signal_id && (payload.direction === 'LONG' || payload.direction === 'SHORT')
    && (payload.option_type === 'call' || payload.option_type === 'put')
    && typeof payload.entry === 'number' && typeof payload.stop_loss === 'number') {
    return 'CRT';
  }
  if (payload.signal_id && payload.risk_r != null && payload.atr != null
    && (payload.take_profit1 != null || payload.take_profit2 != null)) {
    return 'CRT';
  }

  // Reversal Indicator — EME (Expected Move Engine), SPE (Strike Probability), Strat Setup/Trigger
  // signalVal must handle payload.signal as object (SIGNALS format) — only string signals go to REVERSAL
  const signalType = (payload.signal_type || '').toUpperCase();
  const signalVal = (typeof payload.signal === 'string' ? payload.signal : '').toUpperCase();
  if (['EM_CALL_ZONE', 'EM_PUT_ZONE', 'EM_BREAKOUT'].includes(signalType)) return 'REVERSAL';
  if (['PUT_SPREAD_FAVORABLE', 'CALL_SPREAD_FAVORABLE'].includes(signalVal)) return 'REVERSAL';
  if (['STRAT_SETUP', 'STRAT_TRIGGER'].includes(signalVal)) return 'REVERSAL';

  // SIGNALS check runs BEFORE component/level STRAT detection because SIGNALS
  // payloads often include STRAT_SETUP in their components array as a contributing
  // factor, not as a webhook-type identifier.
  if (payload.signal && typeof payload.signal === 'object') {
    const hasScore = (typeof payload.score === 'number') ||
                     (typeof payload.score_breakdown?.total === 'number');
    const hasTrend = payload.trend || payload.trend_data;
    if (hasScore && hasTrend) return 'SIGNALS';
  }

  // STRAT fallback: components or numeric levels (only reached when not SIGNALS)
  if (Array.isArray(payload.components)) {
    const hasStratComponent = payload.components.some(c =>
      c === 'STRAT_SETUP' || c === 'HTF_IGNITION' || c === 'BIAS_SHIFT'
    );
    if (hasStratComponent) return 'STRAT';
  }
  if (typeof payload.entry === 'number' && typeof payload.target === 'number'
    && typeof payload.stop === 'number') return 'STRAT';

  // Fingerprint-based market data detection (no explicit event_type needed)
  if (payload.strike && (payload.expiry || payload.expiration) && payload.sentiment) return 'OPTIONS_FLOW';
  if (payload.price && payload.volume != null && (payload.high || payload.low) && !payload.action && !payload.signal) return 'PRICE_TICK';
  const contracts = payload.contracts || payload.chain;
  if (Array.isArray(contracts) && contracts.length > 0 && (contracts[0].strike != null || contracts[0].openInterest != null || contracts[0].oi != null)) return 'CHAIN_SNAPSHOT';

  return 'UNKNOWN';
}

/**
 * Check if a detected source is a market data type (not a trading signal).
 */
function isMarketDataType(source) {
  return MARKET_DATA_TYPES.includes(source);
}

/**
 * Check if a detected source is a context provider (not a trade trigger).
 */
function isContextSource(source) {
  return CONTEXT_SOURCES.includes(source);
}

/**
 * Extract a normalized direction candidate from any payload shape.
 * Checks 13+ field paths in priority order, normalizing to 'long' or 'short'.
 *
 * @param {Object} payload
 * @returns {'long'|'short'|null}
 */
function extractDirectionCandidate(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const signal = typeof payload.signal === 'object' ? payload.signal : undefined;
  const pattern = signal?.pattern ?? payload.pattern;
  const patternStr = typeof pattern === 'string' ? pattern.toLowerCase() : '';

  if (patternStr.includes('bear') || patternStr.includes('short')) return 'short';
  if (patternStr.includes('bull') || patternStr.includes('long')) return 'long';

  const raw =
    payload.direction ??
    payload.side ??
    payload.trend ??
    payload.bias ??
    payload.setup?.direction ??
    payload.setup?.bias ??
    signal?.type ??
    signal?.direction ??
    signal?.side ??
    payload.regime_context?.local_bias ??
    payload.execution_guidance?.bias ??
    payload.order_action ??
    payload.strategy?.order_action ??
    payload.action ??
    payload.event?.phase_name ??
    null;

  return normalizeDirection(raw);
}

/**
 * Normalize a raw direction string to 'long' or 'short'.
 * @param {*} raw
 * @returns {'long'|'short'|null}
 */
function normalizeDirection(raw) {
  if (raw == null) return null;
  const s = String(raw).toUpperCase().trim();

  if (['LONG', 'BUY', 'BULLISH', 'BULL', 'MARKUP', 'CALL', 'UP'].includes(s) || s.includes('TREND_UP')) return 'long';
  if (['SHORT', 'SELL', 'BEARISH', 'BEAR', 'MARKDOWN', 'PUT', 'DOWN'].includes(s) || s.includes('TREND_DOWN')) return 'short';

  return null;
}

module.exports = {
  detectIndicatorSource,
  isMarketDataType,
  isContextSource,
  extractDirectionCandidate,
  normalizeDirection,
  KNOWN_ORB_INDICATORS,
  MARKET_DATA_TYPES,
  CONTEXT_SOURCES,
  STRAT_PLAN_EVENTS,
};
