'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const { verifySignature, generateDedupeKey, validateTimestamp, validatePayload } = require('./webhook.validator');

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
    const dedupeKey = generateDedupeKey(rawPayload);

    // Deduplication check
    const existing = await db.query(
      'SELECT id, status FROM webhook_events WHERE dedupe_key = $1',
      [dedupeKey]
    );
    if (existing.rows.length > 0) {
      logger.info(`Duplicate webhook detected: ${dedupeKey}`, 'webhook');
      return { event: existing.rows[0], isDuplicate: true };
    }

    // Signature verification
    const signatureValid = WEBHOOK_SECRET
      ? verifySignature(rawBody, signature, WEBHOOK_SECRET)
      : true; // If no secret configured, allow all

    // Timestamp validation
    const tsResult = validateTimestamp(rawPayload);

    // Payload structure validation
    const payloadResult = validatePayload(rawPayload);

    let status = 'RECEIVED';
    let errorMessage = null;

    if (!signatureValid) {
      status = 'REJECTED';
      errorMessage = 'Invalid HMAC signature';
    } else if (!tsResult.valid) {
      status = 'REJECTED';
      errorMessage = tsResult.error;
    } else if (!payloadResult.valid) {
      status = 'REJECTED';
      errorMessage = payloadResult.error;
    }

    const id = uuidv4();
    const result = await db.query(
      `INSERT INTO webhook_events (id, source, raw_payload, signature_valid, dedupe_key, status, error_message, user_id)
       VALUES ($1, 'tradingview', $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, JSON.stringify(rawPayload), signatureValid, dedupeKey, status, errorMessage, userId]
    );

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
   * Get pending (RECEIVED) webhook events for processing
   */
  async getPending(limit = 50) {
    const result = await db.query(
      `SELECT * FROM webhook_events WHERE status = 'RECEIVED' ORDER BY received_at ASC LIMIT $1`,
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
}

module.exports = new WebhookService();
