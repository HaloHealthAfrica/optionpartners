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

const MAX_PAYLOAD_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Verify HMAC-SHA256 signature from TradingView webhook
 */
function verifySignature(payload, signature, secret) {
  if (!secret || !signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex')
  );
}

/**
 * Generate idempotency/dedupe key from payload contents.
 * Indicator-aware: uses source-specific fields for better deduplication.
 */
function generateDedupeKey(payload) {
  const source = detectIndicatorSource(payload);
  const symbol = payload.ticker || payload.symbol || '';
  const ts = payload.time || payload.timestamp || '';

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
      discriminator = [
        payload.signal?.side,
        payload.setup || payload.setupType || payload.setup_type,
        payload.timeframe,
        payload.score,
      ].join(':');
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
        payload.score,
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
 * Validate timestamp freshness to prevent replay attacks
 */
function validateTimestamp(payload) {
  const ts = payload.time || payload.timestamp || payload.fired_at;
  if (!ts) return { valid: true };

  let payloadTime;
  if (typeof ts === 'number') {
    // Unix seconds vs milliseconds: if < 10 billion, treat as seconds
    payloadTime = ts < 1e10 ? ts * 1000 : ts;
  } else {
    payloadTime = new Date(ts).getTime();
  }

  if (isNaN(payloadTime)) {
    return { valid: false, error: 'Invalid timestamp format' };
  }

  const age = Date.now() - payloadTime;
  if (age > MAX_PAYLOAD_AGE_MS) {
    return { valid: false, error: `Payload too old: ${Math.round(age / 1000)}s (max ${MAX_PAYLOAD_AGE_MS / 1000}s)` };
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
    const symbol = payload.ticker || payload.symbol || payload.instrument?.ticker || payload.instrument?.symbol;
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
