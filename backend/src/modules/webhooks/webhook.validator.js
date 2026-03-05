'use strict';

const crypto = require('crypto');
const { detectIndicatorSource } = require('./indicator-detector');

/**
 * @typedef {Object} WebhookValidationResult
 * @property {boolean} valid
 * @property {string} [error]
 * @property {string} dedupeKey
 * @property {boolean} signatureValid
 */

const MAX_PAYLOAD_AGE_MS = 5 * 60 * 1000; // 5 minutes (default for unknown sources)

// Source-specific max ages — bar timestamps on longer timeframes are naturally older
const MAX_AGE_BY_SOURCE = {
  MARKET_CONTEXT: 8 * 24 * 60 * 60 * 1000, // 8 days (weekly bars)
  TREND:          8 * 24 * 60 * 60 * 1000,
  MTF_BIAS:       8 * 24 * 60 * 60 * 1000,
  SATY_PHASE:     8 * 24 * 60 * 60 * 1000,
  STRAT:          30 * 60 * 1000,            // 30 minutes
  SIGNALS:        30 * 60 * 1000,
  ORB:            30 * 60 * 1000,
  SQUEEZE_PRO:    30 * 60 * 1000,
  PIVOT_MB:       30 * 60 * 1000,
};

/**
 * Verify HMAC-SHA256 signature from TradingView webhook
 */
function verifySignature(payload, signature, secret) {
  if (!secret || !signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
    .digest('hex');
  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/**
 * Generate idempotency/dedupe key from payload contents.
 * Indicator-aware: uses source-specific fields for better deduplication.
 *
 * The timestamp component is resolved with source-aware fallbacks so that
 * payloads with nested timestamps (e.g. signal.bar_time) still produce
 * unique keys across different bar periods.
 */
function generateDedupeKey(payload) {
  const source = detectIndicatorSource(payload);
  const symbol = payload.ticker || payload.symbol || payload.meta?.symbol || '';

  const ts = _resolveTimestamp(payload, source);

  let discriminator;
  switch (source) {
    case 'SATY_PHASE':
      discriminator = [
        payload.regime_context?.local_bias,
        payload.event?.phase_name,
        payload.timeframe,
      ].join(':');
      break;
    case 'STRAT':
      if (payload.plan_id) {
        discriminator = [payload.plan_id, payload.event].join(':');
      } else {
        discriminator = [
          payload.signal?.side,
          payload.setup || payload.setupType || payload.setup_type,
          payload.timeframe,
          payload.score,
        ].join(':');
      }
      break;
    case 'TREND':
      discriminator = [
        payload.bias,
        payload.trigger_timeframe,
        payload.alignment_score,
      ].join(':');
      break;
    case 'ORB':
      discriminator = [
        payload.indicator,
        payload.action || payload.side,
        payload.entry,
      ].join(':');
      break;
    case 'SIGNALS':
      discriminator = payload.signal_id || [
        payload.direction,
        payload.pattern || payload.setup,
        payload.score ?? payload.score_breakdown?.total,
      ].join(':');
      break;
    case 'MTF_BIAS':
      discriminator = payload.event_id_raw || [
        payload.mtf?.consensus?.bias_consensus,
        payload.trigger?.pattern,
        payload.chart_tf,
      ].join(':');
      break;
    case 'SQUEEZE_PRO':
      discriminator = [
        payload.direction,
        payload.timeframe,
        payload.momentum,
        payload.compression_score,
      ].join(':');
      break;
    case 'PIVOT_MB':
      discriminator = [
        payload.direction || payload.signal_type,
        payload.timeframe,
        payload.price,
      ].join(':');
      break;
    case 'MARKET_CONTEXT':
      discriminator = [
        payload.event,
        payload.timeframe,
        payload.regime?.current,
        payload.direction,
      ].join(':');
      break;
    default:
      discriminator = [
        payload.action || payload.order_action,
        payload.strategy || payload.alert_name,
        payload.alert_id,
      ].join(':');
  }

  const parts = [source, symbol, ts, discriminator].join('|');
  return crypto.createHash('sha256').update(parts).digest('hex').substring(0, 40);
}

/**
 * Resolve the best available timestamp from a payload.
 * Source-aware: checks nested timestamp locations that each indicator type uses,
 * then falls back to wall-clock time to guarantee cross-day uniqueness.
 */
function _resolveTimestamp(payload, source) {
  // Top-level timestamp fields (checked first for all sources)
  const topLevel = payload.time || payload.timestamp || payload.event_ts_ms || payload.meta?.ts;
  if (topLevel) return String(topLevel);

  // Source-specific nested timestamp locations
  switch (source) {
    case 'SIGNALS':
      if (payload.signal?.bar_time) return payload.signal.bar_time;
      if (payload.entry?.bar_time) return payload.entry.bar_time;
      break;
    case 'STRAT':
      if (payload.setup?.bar_time) return payload.setup.bar_time;
      if (payload.plan?.created_at) return payload.plan.created_at;
      break;
    case 'SATY_PHASE':
      if (payload.phase_timestamp) return payload.phase_timestamp;
      break;
    case 'SQUEEZE_PRO':
      if (payload.bar_time) return payload.bar_time;
      break;
    case 'PIVOT_MB':
      if (payload.bar_time) return payload.bar_time;
      break;
    case 'TREND':
      if (payload.meta?.bar_time) return payload.meta.bar_time;
      break;
  }

  // Final fallback: use current wall-clock minute to prevent cross-day dedup.
  // Rounded to the minute so that exact-duplicate retries within 60s still dedup.
  const now = new Date();
  now.setSeconds(0, 0);
  return now.toISOString();
}

/**
 * Validate timestamp freshness to prevent replay attacks.
 * @param {Object} payload
 * @param {string} [source] - Detected indicator source for source-specific limits
 */
function validateTimestamp(payload, source) {
  const ts = payload.time || payload.timestamp || payload.event_ts_ms || payload.fired_at || payload.meta?.ts;
  if (!ts) return { valid: true };

  let payloadTime;
  const numericTs = typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : ts;
  if (typeof numericTs === 'number') {
    // Unix seconds vs milliseconds: if < 10 billion, treat as seconds
    payloadTime = numericTs < 1e10 ? numericTs * 1000 : numericTs;
  } else {
    payloadTime = new Date(ts).getTime();
  }

  if (isNaN(payloadTime)) {
    return { valid: false, error: 'Invalid timestamp format' };
  }

  const maxAge = (source && MAX_AGE_BY_SOURCE[source]) || MAX_PAYLOAD_AGE_MS;
  const age = Date.now() - payloadTime;
  if (age > maxAge) {
    return { valid: false, error: `Payload too old: ${Math.round(age / 1000)}s (max ${Math.round(maxAge / 1000)}s)` };
  }
  if (age < -60000) {
    return { valid: false, error: 'Payload timestamp is in the future' };
  }

  return { valid: true };
}

/**
 * Validate the webhook payload structure.
 * Indicator-aware: known indicator payloads pass if they have a symbol and a
 * direction source, even without an explicit `action` field.
 */
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Payload must be a JSON object' };
  }

  const source = detectIndicatorSource(payload);

  // Known indicators carry their own direction semantics — symbol is sufficient
  if (source !== 'UNKNOWN') {
    const symbol = payload.ticker || payload.symbol || payload.meta?.symbol || payload.instrument?.ticker || payload.instrument?.symbol;
    if (!symbol || typeof symbol !== 'string') {
      return { valid: false, error: `[${source}] Missing required field: ticker or symbol` };
    }
    return { valid: true, source };
  }

  // Generic / unknown payloads keep the original strict validation
  const symbol = payload.ticker || payload.symbol;
  if (!symbol || typeof symbol !== 'string') {
    return { valid: false, error: 'Missing required field: ticker or symbol' };
  }

  const action = payload.action || payload.order_action;
  if (!action || typeof action !== 'string') {
    return { valid: false, error: 'Missing required field: action or order_action' };
  }

  const validActions = ['buy', 'sell', 'close', 'BUY', 'SELL', 'CLOSE'];
  if (!validActions.includes(action)) {
    return { valid: false, error: `Invalid action: ${action}. Must be one of: ${validActions.join(', ')}` };
  }

  return { valid: true, source };
}

module.exports = {
  verifySignature,
  generateDedupeKey,
  validateTimestamp,
  validatePayload,
  MAX_PAYLOAD_AGE_MS,
};
