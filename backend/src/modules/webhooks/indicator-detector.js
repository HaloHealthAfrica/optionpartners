'use strict';

/**
 * Indicator source detection and direction extraction.
 *
 * Detection priority matches the reference spec exactly — first match wins.
 * MTF Bias V3/V1 are intercepted at the router level before this function
 * is called (checked via `event_id_raw`).
 */

const KNOWN_ORB_INDICATORS = ['ORB', 'Stretch', 'BHCH', 'EMA'];

/**
 * Identify which indicator produced this webhook payload.
 * @param {Object} payload - Raw webhook payload
 * @returns {string} Source identifier
 */
function detectIndicatorSource(payload) {
  if (!payload || typeof payload !== 'object') return 'UNKNOWN';

  const metaEngine = payload.meta?.engine;
  const journalEngine = payload.journal?.engine;

  if (metaEngine === 'SATY_PO') return 'SATY_PHASE';
  if (journalEngine === 'STRAT_V6_FULL') return 'STRAT';
  if (payload.timeframes && payload.bias && payload.ticker) return 'TREND';
  if (payload.indicator && KNOWN_ORB_INDICATORS.includes(payload.indicator)) return 'ORB';
  if (payload.trend && payload.score !== undefined && typeof payload.score === 'number' && payload.signal) {
    return 'SIGNALS';
  }

  return 'UNKNOWN';
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

  if (['LONG', 'BUY', 'BULLISH', 'BULL', 'MARKUP', 'CALL'].includes(s)) return 'long';
  if (['SHORT', 'SELL', 'BEARISH', 'BEAR', 'MARKDOWN', 'PUT'].includes(s)) return 'short';

  return null;
}

module.exports = {
  detectIndicatorSource,
  extractDirectionCandidate,
  normalizeDirection,
  KNOWN_ORB_INDICATORS,
};
