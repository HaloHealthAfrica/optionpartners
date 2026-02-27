'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const { verifySignature, generateDedupeKey, validateTimestamp, validatePayload } = require('./webhook.validator');
const { detectIndicatorSource, isMarketDataType } = require('./indicator-detector');
const symbolStateService = require('../sim/symbol-state.service');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

/**
 * @typedef {Object} WebhookEvent
 * @property {string} id
 * @property {Date} received_at
 * @property {string} source
 * @property {Object} raw_payload
 * @property {boolean} signature_valid
 * @property {string} dedupe_key
 * @property {string} status
 * @property {string|null} error_message
 */

class WebhookService {
  /**
   * Ingest a raw webhook payload. Returns the stored event or rejects duplicates.
   * @param {Object} rawPayload
   * @param {string} rawBody - Raw string body for signature verification
   * @param {string} [signature] - HMAC signature header
   * @param {string} [userId] - Associated user ID (from API key or auth)
   * @returns {Promise<{event: WebhookEvent, isDuplicate: boolean}>}
   */
  async ingest(rawPayload, rawBody, signature, userId) {
    // Test ping early-exit — acknowledge without queueing for processing
    if (rawPayload.test === true || rawPayload.type === 'PING') {
      const id = uuidv4();
      const result = await db.query(
        `INSERT INTO webhook_events (id, source, raw_payload, signature_valid, dedupe_key, status, error_message, user_id)
         VALUES ($1, 'tradingview', $2, true, $3, 'TEST_PING', NULL, $4)
         RETURNING *`,
        [id, JSON.stringify(rawPayload), `ping_${id}`, userId]
      );
      logger.info(`Test ping received: ${id}`, 'webhook');
      return { event: result.rows[0], isDuplicate: false, isTestPing: true };
    }

    // Signature verification runs FIRST — before any routing or storage
    const signatureValid = WEBHOOK_SECRET
      ? verifySignature(rawBody, signature, WEBHOOK_SECRET)
      : true;

    if (!signatureValid) {
      const id = uuidv4();
      const result = await db.query(
        `INSERT INTO webhook_events (id, source, raw_payload, signature_valid, dedupe_key, status, error_message, user_id)
         VALUES ($1, 'tradingview', $2, false, $3, 'REJECTED', 'Invalid HMAC signature', $4)
         RETURNING *`,
        [id, JSON.stringify(rawPayload), `rejected_sig_${id}`, userId]
      );
      return { event: result.rows[0], isDuplicate: false };
    }

    // Detect source early so timestamp validation uses source-specific limits
    const detectedSource = detectIndicatorSource(rawPayload);

    // Timestamp validation with source-aware max age
    const tsResult = validateTimestamp(rawPayload, detectedSource);
    if (!tsResult.valid) {
      const id = uuidv4();
      const result = await db.query(
        `INSERT INTO webhook_events (id, source, raw_payload, signature_valid, dedupe_key, status, error_message, user_id)
         VALUES ($1, 'tradingview', $2, true, $3, 'REJECTED', $4, $5)
         RETURNING *`,
        [id, JSON.stringify(rawPayload), `rejected_ts_${id}`, tsResult.error, userId]
      );
      return { event: result.rows[0], isDuplicate: false };
    }

    // Market data auto-routing (now runs AFTER security validation)
    if (isMarketDataType(detectedSource)) {
      return this._routeMarketData(detectedSource, rawPayload, userId);
    }

    const dedupeKey = generateDedupeKey(rawPayload);

    // Payload structure validation
    const payloadResult = validatePayload(rawPayload);

    let status = 'RECEIVED';
    let errorMessage = null;

    if (!payloadResult.valid) {
      status = 'REJECTED';
      errorMessage = payloadResult.error;
    }

    // Atomic insert with dedupe: ON CONFLICT returns existing row
    const id = uuidv4();
    const result = await db.query(
      `INSERT INTO webhook_events (id, source, raw_payload, signature_valid, dedupe_key, status, error_message, user_id)
       VALUES ($1, 'tradingview', $2, $3, $4, $5, $6, $7)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING *`,
      [id, JSON.stringify(rawPayload), signatureValid, dedupeKey, status, errorMessage, userId]
    );

    if (result.rows.length === 0) {
      const existing = await db.query(
        'SELECT id, status FROM webhook_events WHERE dedupe_key = $1',
        [dedupeKey]
      );
      logger.info(`Duplicate webhook detected: ${dedupeKey}`, 'webhook');
      return { event: existing.rows[0], isDuplicate: true };
    }

    const event = result.rows[0];
    logger.info(`Webhook stored: ${id} status=${status}`, 'webhook');

    return { event, isDuplicate: false };
  }

  /**
   * Mark a webhook event as processed
   */
  async markProcessed(eventId) {
    await db.query(
      `UPDATE webhook_events SET status = 'PROCESSED', processed_at = NOW() WHERE id = $1`,
      [eventId]
    );
  }

  /**
   * Mark a webhook event as rejected with reason
   */
  async markRejected(eventId, reason) {
    await db.query(
      `UPDATE webhook_events SET status = 'REJECTED', error_message = $2, processed_at = NOW() WHERE id = $1`,
      [eventId, reason]
    );
  }

  /**
   * Mark a webhook event for retry (requeue from REJECTED back to RECEIVED).
   * Only allows retry for processing errors, not validation failures.
   */
  async markForRetry(eventId) {
    const result = await db.query(
      `UPDATE webhook_events
       SET status = 'RECEIVED',
           retry_count = COALESCE(retry_count, 0) + 1,
           error_message = NULL,
           processed_at = NULL
       WHERE id = $1
         AND status = 'REJECTED'
         AND error_message LIKE 'Processing error:%'
         AND COALESCE(retry_count, 0) < 3
       RETURNING *`,
      [eventId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get pending (RECEIVED) webhook events for processing.
   * Also picks up REJECTED events eligible for automatic retry (processing errors only, < 3 attempts).
   */
  async getPending(limit = 50) {
    const result = await db.query(
      `SELECT * FROM webhook_events
       WHERE status = 'RECEIVED'
          OR (status = 'REJECTED'
              AND error_message LIKE 'Processing error:%'
              AND COALESCE(retry_count, 0) < 3
              AND processed_at < NOW() - INTERVAL '30 seconds')
       ORDER BY received_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    return result.rows;
  }

  /**
   * List webhook events with pagination and filtering
   */
  async list({ userId, status, page = 1, limit = 25 }) {
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (userId) {
      conditions.push(`user_id = $${paramIdx++}`);
      params.push(userId);
    }
    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT * FROM webhook_events ${where} ORDER BY received_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        [...params, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*) as total FROM webhook_events ${where}`,
        params
      ),
    ]);

    return {
      events: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
      page,
      limit,
    };
  }

  /**
   * Get a single webhook event by ID
   */
  async getById(eventId, userId) {
    const result = await db.query(
      'SELECT * FROM webhook_events WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)',
      [eventId, userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Route a detected market data payload to the correct ingestion method.
   * Returns the same shape as ingest() so the controller handles it uniformly.
   */
  async _routeMarketData(source, payload, userId) {
    let result;
    switch (source) {
      case 'OPTIONS_FLOW':
        result = await this.ingestOptionsFlow(payload, userId);
        break;
      case 'PRICE_TICK':
        result = await this.ingestPriceTick(payload, userId);
        break;
      case 'CHAIN_SNAPSHOT':
        result = await this.ingestChainSnapshot(payload, userId);
        break;
      default:
        throw new Error(`Unknown market data type: ${source}`);
    }
    return {
      event: { id: result.id, status: 'MARKET_DATA', source },
      isDuplicate: false,
      isMarketData: true,
      marketDataType: source,
    };
  }

  // ── Market Data Ingestion ──

  /**
   * Store an options flow event and structured record.
   * @param {Object} payload - Raw flow payload
   * @param {string} [userId]
   * @returns {Promise<Object>} The stored flow record
   */
  async ingestOptionsFlow(payload, userId) {
    const symbol = (payload.symbol || payload.ticker || '').toUpperCase();
    if (!symbol) throw new Error('Missing symbol');

    const id = uuidv4();
    const dedupeKey = `flow:${symbol}:${payload.strike || ''}:${payload.expiry || payload.expiration || ''}:${payload.timestamp || payload.time || ''}`;

    const existing = await db.query(
      'SELECT id FROM market_data_events WHERE dedupe_key = $1',
      [dedupeKey]
    );
    if (existing.rows.length > 0) {
      logger.info(`Duplicate options flow skipped: ${dedupeKey}`, 'webhook');
      return { id: existing.rows[0].id, symbol, duplicate: true };
    }

    await db.query(
      `INSERT INTO market_data_events (id, event_type, symbol, raw_payload, user_id, dedupe_key)
       VALUES ($1, 'OPTIONS_FLOW', $2, $3, $4, $5)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [id, symbol, JSON.stringify(payload), userId, dedupeKey]
    );

    const flowResult = await db.query(
      `INSERT INTO options_flow (symbol, flow_type, strike, expiry, premium, size, sentiment, unusual, raw_payload, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        symbol,
        payload.type || 'call',
        parseFloat(payload.strike) || 0,
        payload.expiry || payload.expiration || new Date().toISOString().slice(0, 10),
        parseFloat(payload.premium) || null,
        parseInt(payload.size, 10) || null,
        payload.sentiment || null,
        payload.unusual === true,
        JSON.stringify(payload),
        userId,
      ]
    );

    logger.info(`Options flow stored: ${symbol} ${payload.type} ${payload.strike} unusual=${payload.unusual}`, 'webhook');

    try {
      await symbolStateService.update('OPTIONS_FLOW', payload, userId, symbol);
    } catch (err) {
      logger.error(`Failed to update symbol state from flow: ${err.message}`, 'webhook');
    }

    return flowResult.rows[0];
  }

  /**
   * Store a price tick and upsert the price cache.
   * @param {Object} payload - Raw price payload
   * @param {string} [userId]
   * @returns {Promise<Object>} The cached price record
   */
  async ingestPriceTick(payload, userId) {
    const symbol = (payload.symbol || payload.ticker || '').toUpperCase();
    if (!symbol) throw new Error('Missing symbol');

    const price = parseFloat(payload.price);
    if (isNaN(price)) throw new Error('Missing or invalid price');

    const id = uuidv4();
    const ts = payload.timestamp || payload.time || '';
    const dedupeKey = `price:${symbol}:${ts}:${price}`;

    await db.query(
      `INSERT INTO market_data_events (id, event_type, symbol, raw_payload, user_id, dedupe_key)
       VALUES ($1, 'PRICE_TICK', $2, $3, $4, $5)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [id, symbol, JSON.stringify(payload), userId, dedupeKey]
    );

    const parsedVolume = parseInt(payload.volume, 10);
    const parsedHigh = parseFloat(payload.high);
    const parsedLow = parseFloat(payload.low);
    const parsedOpen = parseFloat(payload.open);

    const cacheResult = await db.query(
      `INSERT INTO price_cache (symbol, price, volume, high, low, open, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (symbol) DO UPDATE SET
         price = EXCLUDED.price,
         volume = EXCLUDED.volume,
         high = EXCLUDED.high,
         low = EXCLUDED.low,
         open = EXCLUDED.open,
         timestamp = EXCLUDED.timestamp,
         updated_at = NOW()
       RETURNING *`,
      [
        symbol,
        price,
        isNaN(parsedVolume) ? null : parsedVolume,
        isNaN(parsedHigh) ? null : parsedHigh,
        isNaN(parsedLow) ? null : parsedLow,
        isNaN(parsedOpen) ? null : parsedOpen,
        payload.timestamp || null,
      ]
    );

    logger.info(`Price tick stored: ${symbol} $${price}`, 'webhook');

    try {
      await symbolStateService.update('PRICE_TICK', payload, userId, symbol);
    } catch (err) {
      logger.error(`Failed to update symbol state from price tick: ${err.message}`, 'webhook');
    }

    return cacheResult.rows[0];
  }

  /**
   * Store a chain snapshot event.
   * @param {Object} payload - Raw chain payload (passthrough, only symbol required)
   * @param {string} [userId]
   * @returns {Promise<Object>} The stored event
   */
  async ingestChainSnapshot(payload, userId) {
    const symbol = (payload.symbol || payload.ticker || '').toUpperCase();
    if (!symbol) throw new Error('Missing symbol');

    const id = uuidv4();
    const ts = payload.timestamp || payload.time || '';
    const contractCount = Array.isArray(payload.contracts || payload.chain) ? (payload.contracts || payload.chain).length : 0;
    const dedupeKey = `chain:${symbol}:${ts}:${contractCount}`;

    const existing = await db.query(
      'SELECT id FROM market_data_events WHERE dedupe_key = $1',
      [dedupeKey]
    );
    if (existing.rows.length > 0) {
      logger.info(`Duplicate chain snapshot skipped: ${dedupeKey}`, 'webhook');
      return { id: existing.rows[0].id, symbol, duplicate: true };
    }

    const result = await db.query(
      `INSERT INTO market_data_events (id, event_type, symbol, raw_payload, user_id, dedupe_key)
       VALUES ($1, 'CHAIN_SNAPSHOT', $2, $3, $4, $5)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING *`,
      [id, symbol, JSON.stringify(payload), userId, dedupeKey]
    );

    if (result.rows.length === 0) {
      return { id, symbol, duplicate: true };
    }

    logger.info(`Chain snapshot stored: ${symbol}`, 'webhook');

    try {
      await symbolStateService.update('CHAIN_SNAPSHOT', payload, userId, symbol);
    } catch (err) {
      logger.error(`Failed to update symbol state from chain: ${err.message}`, 'webhook');
    }

    return result.rows[0];
  }
}

module.exports = new WebhookService();
