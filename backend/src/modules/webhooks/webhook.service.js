'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');
const { verifySignature, generateDedupeKey, validateTimestamp, validatePayload } = require('./webhook.validator');
const { detectIndicatorSource, isMarketDataType } = require('./indicator-detector');
const symbolStateService = require('../sim/symbol-state.service');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
let _sourceColumnCache = null;

async function _getSourceColumn() {
  if (_sourceColumnCache !== null) return _sourceColumnCache;
  const r = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'webhook_events'
     AND column_name IN ('indicator_source', 'strategy_detected')
     ORDER BY CASE column_name WHEN 'indicator_source' THEN 0 ELSE 1 END LIMIT 1`
  );
  _sourceColumnCache = r.rows[0]?.column_name || null;
  return _sourceColumnCache;
}

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
   * @param {Object} [sourceInfo] - Source identification info { clientIP, userAgent, apiKeyId }
   * @returns {Promise<{event: WebhookEvent, isDuplicate: boolean}>}
   */
  async ingest(rawPayload, rawBody, signature, userId, sourceInfo = {}) {
    let { clientIP, userAgent, apiKeyId } = sourceInfo;
    // PostgreSQL INET rejects 'unknown' — use null for storage
    if (clientIP === 'unknown') clientIP = null;
    // Test ping early-exit — acknowledge without queueing for processing
    if (rawPayload.test === true || rawPayload.type === 'PING') {
      const id = uuidv4();
      const result = await db.query(
        `INSERT INTO webhook_events (id, source, raw_payload, signature_valid, dedupe_key, status, error_message, user_id, client_ip, user_agent, api_key_id)
         VALUES ($1, 'tradingview', $2, true, $3, 'TEST_PING', NULL, $4, $5, $6, $7)
         RETURNING *`,
        [id, JSON.stringify(rawPayload), `ping_${id}`, userId, clientIP, userAgent, apiKeyId]
      );
      logger.info(`Test ping received: ${id}`, 'webhook');
      return { event: result.rows[0], isDuplicate: false, isTestPing: true };
    }

    // Signature verification is optional — we record validity for auditing but never reject
    const signatureValid = WEBHOOK_SECRET
      ? verifySignature(rawBody, signature, WEBHOOK_SECRET)
      : true;

    // Detect source early so timestamp validation uses source-specific limits
    const detectedSource = detectIndicatorSource(rawPayload);

    // Timestamp validation with source-aware max age
    const tsResult = validateTimestamp(rawPayload, detectedSource);
    if (!tsResult.valid) {
      const id = uuidv4();
      const result = await db.query(
        `INSERT INTO webhook_events (id, source, indicator_source, raw_payload, signature_valid, dedupe_key, status, error_message, user_id, client_ip, user_agent, api_key_id)
         VALUES ($1, 'tradingview', $2, $3, true, $4, 'REJECTED', $5, $6, $7, $8, $9)
         RETURNING *`,
        [id, detectedSource, JSON.stringify(rawPayload), `rejected_ts_${id}`, tsResult.error, userId, clientIP, userAgent, apiKeyId]
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
      `INSERT INTO webhook_events (id, source, indicator_source, raw_payload, signature_valid, dedupe_key, status, error_message, user_id, client_ip, user_agent, api_key_id)
       VALUES ($1, 'tradingview', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING *`,
      [id, detectedSource, JSON.stringify(rawPayload), signatureValid, dedupeKey, status, errorMessage, userId, clientIP, userAgent, apiKeyId]
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
   * Set the detected indicator source on a webhook event.
   * Called during processing to ensure indicator_source is always populated,
   * even for events ingested before the column was added.
   */
  async setIndicatorSource(eventId, indicatorSource) {
    if (!indicatorSource) return;
    const col = await _getSourceColumn();
    if (!col) return;
    await db.query(
      `UPDATE webhook_events SET ${col} = $2 WHERE id = $1`,
      [eventId, indicatorSource]
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
    const row = result.rows[0] || null;
    if (row) {
      logger.info(`Webhook event ${eventId} requeued for retry (count=${row.retry_count})`, 'webhook');
    } else {
      logger.warn(`Webhook event ${eventId} not eligible for retry`, 'webhook');
    }
    return row;
  }

  /**
   * Bulk requeue REJECTED events (processing errors only) for retry.
   * Resets status to RECEIVED so they get picked up by the processor.
   * Optional: limit to events from past N days.
   */
  async bulkRequeueForRetry(days = 3) {
    const result = await db.query(
      `UPDATE webhook_events
       SET status = 'RECEIVED',
           retry_count = COALESCE(retry_count, 0) + 1,
           error_message = NULL,
           processed_at = NULL
       WHERE status = 'REJECTED'
         AND error_message LIKE 'Processing error:%'
         AND COALESCE(retry_count, 0) < 3
         AND received_at >= NOW() - (INTERVAL '1 day' * $1)
       RETURNING id`,
      [days]
    );
    const count = result.rowCount || 0;
    if (count > 0) {
      logger.info(`Bulk requeue: ${count} webhook(s) reset to RECEIVED for retry`, 'webhook');
    }
    return { requeued: count, ids: result.rows.map(r => r.id) };
  }

  /**
   * Get pending (RECEIVED) webhook events for processing.
   * Also picks up REJECTED events eligible for automatic retry (processing errors only, < 3 attempts).
   */
  async getPending(limit = 50) {
    // Select events ready for processing. Includes:
    //  - Freshly RECEIVED events.
    //  - Previously REJECTED events with a processing error that are still
    //    eligible for retry.  Retries are spaced using an exponential backoff
    //    multiplier (30s, 60s, 120s, ...), capped to avoid huge delays.
    const result = await db.query(
      `SELECT * FROM webhook_events
       WHERE status = 'RECEIVED'
          OR (status = 'REJECTED'
              AND error_message LIKE 'Processing error:%'
              AND COALESCE(retry_count, 0) < 3
              -- exponential backoff: 30s * 2^retry_count, cap factor at 64
              AND processed_at < NOW() - (INTERVAL '30 seconds' * LEAST(POWER(2, COALESCE(retry_count,0)), 64)))
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
   * Check if userId is the default/sim user (webhooks with user_id=NULL may belong to them).
   */
  async _isDefaultUser(userId) {
    const envId = process.env.SIM_DEFAULT_USER_ID;
    if (envId && envId === userId) return true;
    if (process.env.NODE_ENV !== 'production') {
      const result = await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
      if (result.rows[0]?.id === userId) return true;
    }
    return false;
  }

  /**
   * Extract strategy name from payload (broad field coverage for backtest filtering).
   */
  _extractStrategyFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const s = payload.strategy ?? payload.pattern ?? payload.meta?.strategy ?? payload.meta?.pattern
      ?? payload.setup?.pattern ?? payload.setup?.strategy ?? payload.setup?.strategy_name
      ?? (typeof payload.strategy === 'object' ? payload.strategy?.name ?? payload.strategy?.pattern : null)
      ?? payload.signal?.pattern ?? payload.signal?.strategy ?? '';
    return String(s || '').toLowerCase();
  }

  /**
   * Get webhooks by date range for backtest replay.
   * @param {string} userId
   * @param {string} startDate - ISO date (YYYY-MM-DD)
   * @param {string} endDate - ISO date (YYYY-MM-DD)
   * @param {Object} [options]
   * @param {string[]} [options.indicatorSources] - Filter by indicator_source (STRAT, SIGNALS, REVERSAL, etc.)
   * @param {string[]} [options.strategies] - Filter by strategy name (from normalizers)
   * @param {number} [options.limit=5000]
   * @returns {Promise<Object[]>}
   */
  async getByDateRange(userId, startDate, endDate, options = {}) {
    const { indicatorSources = null, strategies = null, limit = 5000 } = options;

    // Include user_id IS NULL when requesting user is the default/sim user (unassigned webhooks)
    const includeUnassigned = await this._isDefaultUser(userId);
    const userCondition = includeUnassigned ? '(user_id = $1 OR user_id IS NULL)' : 'user_id = $1';

    const conditions = [userCondition, 'received_at >= $2::date', 'received_at < ($3::date + INTERVAL \'1 day\')'];
    const params = [userId, startDate, endDate];
    let paramIdx = 4;

    if (indicatorSources && indicatorSources.length > 0) {
      const sourceSet = new Set(indicatorSources.map((s) => String(s).toUpperCase()));
      conditions.push(`(indicator_source = ANY($${paramIdx}) OR indicator_source IS NULL)`);
      params.push(indicatorSources);
      paramIdx++;
    }

    params.push(limit);
    const result = await db.query(
      `SELECT * FROM webhook_events
       WHERE ${conditions.join(' AND ')}
       ORDER BY received_at ASC
       LIMIT $${paramIdx}`,
      params
    );

    let rows = result.rows;

    if (indicatorSources && indicatorSources.length > 0) {
      const sourceSet = new Set(indicatorSources.map((s) => String(s).toUpperCase()));
      rows = rows.filter((r) => {
        const payload = typeof r.raw_payload === 'string' ? JSON.parse(r.raw_payload) : r.raw_payload;
        const dbSource = (r.indicator_source || '').toUpperCase();
        if (dbSource && sourceSet.has(dbSource)) return true;
        if (!dbSource) {
          const detected = detectIndicatorSource(payload);
          return sourceSet.has(detected);
        }
        return false;
      });
    }

    if (strategies && strategies.length > 0) {
      const stratSet = new Set(strategies.map((s) => String(s).toLowerCase()));
      rows = rows.filter((r) => {
        const payload = typeof r.raw_payload === 'string' ? JSON.parse(r.raw_payload) : r.raw_payload;
        const s = this._extractStrategyFromPayload(payload);
        if (!s) return false;
        return stratSet.has(s) || (payload.setup && typeof payload.setup === 'object' && stratSet.has(String(payload.setup.pattern || payload.setup.strategy || '').toLowerCase()));
      });
    }

    return rows;
  }

  /**
   * Get webhook count for a date range (for backtest preflight).
   * @param {string} userId
   * @param {string} startDate - YYYY-MM-DD
   * @param {string} endDate - YYYY-MM-DD
   * @param {Object} [options]
   * @param {string[]} [options.indicatorSources]
   * @param {string[]} [options.strategies]
   * @returns {Promise<number>}
   */
  async getCountByDateRange(userId, startDate, endDate, options = {}) {
    const rows = await this.getByDateRange(userId, startDate, endDate, {
      ...options,
      limit: 10000,
    });
    return rows.length;
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
      Sentry.captureException(err, { tags: { module: 'webhook-service' } });
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
      Sentry.captureException(err, { tags: { module: 'webhook-service' } });
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
      Sentry.captureException(err, { tags: { module: 'webhook-service' } });
    }

    return result.rows[0];
  }
  /**
   * Move permanently failed events (rejected with max retries exhausted) to
   * DEAD_LETTER status and log an alert. Called periodically by the processor.
   */
  async escalateDeadLetters() {
    try {
      const result = await db.query(
        `UPDATE webhook_events
         SET status = 'DEAD_LETTER', processed_at = NOW()
         WHERE status = 'REJECTED'
           AND error_message LIKE 'Processing error:%'
           AND COALESCE(retry_count, 0) >= 3
         RETURNING id, raw_payload->>'ticker' as symbol, error_message`
      );
      if (result.rows.length > 0) {
        logger.warn(`[DEAD_LETTER] Escalated ${result.rows.length} permanently failed webhook(s)`, 'webhook');
        Sentry.captureMessage(`${result.rows.length} webhook event(s) moved to dead letter queue`, {
          level: 'warning',
          tags: { module: 'webhook-service' },
          extra: { events: result.rows.map(r => ({ id: r.id, symbol: r.symbol })) },
        });
      }
      return result.rows;
    } catch (err) {
      logger.error(`Dead letter escalation failed: ${err.message}`, 'webhook');
      return [];
    }
  }

  /**
   * Cleanup old webhook events beyond a retention period.
   * Prevents unbounded table growth.
   */
  async cleanupOldEvents(retentionDays = 30) {
    try {
      const result = await db.query(
        `DELETE FROM webhook_events
         WHERE received_at < NOW() - INTERVAL '1 day' * $1
           AND status IN ('PROCESSED', 'DEAD_LETTER', 'TEST_PING')
         RETURNING id`,
        [retentionDays]
      );

      const marketResult = await db.query(
        `DELETE FROM market_data_events
         WHERE received_at < NOW() - INTERVAL '1 day' * $1
         RETURNING id`,
        [retentionDays]
      );

      const total = (result.rows.length || 0) + (marketResult.rows.length || 0);
      if (total > 0) {
        logger.info(`[CLEANUP] Deleted ${result.rows.length} webhook events and ${marketResult.rows.length} market data events older than ${retentionDays} days`, 'webhook');
      }
      return total;
    } catch (err) {
      logger.error(`Event cleanup failed: ${err.message}`, 'webhook');
      return 0;
    }
  }
}

module.exports = new WebhookService();
