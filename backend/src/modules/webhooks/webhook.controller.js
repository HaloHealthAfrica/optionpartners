'use strict';

const webhookService = require('./webhook.service');
const db = require('../../config/database');
const { assertSimMode } = require('../../config/tradingMode');
const logger = require('../../utils/logger');

/**
 * Resolve user ID from req.user (JWT), x-api-key header, or SIM default user.
 * Priority: JWT > API key > SIM_DEFAULT_USER_ID env > first registered user.
 * @returns {Promise<string|null>}
 */
async function _resolveUserId(req) {
  if (req.user?.id) return req.user.id;

  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    try {
      const result = await db.query(
        `SELECT user_id FROM api_keys
         WHERE key_hash = encode(digest($1, 'sha256'), 'hex')
           AND revoked_at IS NULL
           AND is_active = TRUE
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [apiKey]
      );
      if (result.rows[0]?.user_id) return result.rows[0].user_id;
    } catch (err) {
      logger.warn(`API key lookup failed: ${err.message}`, 'webhook');
    }
  }

  // Fallback for unauthenticated webhooks (paper trading convenience)
  return _getDefaultUserId();
}

let _cachedDefaultUserId = null;
async function _getDefaultUserId() {
  if (_cachedDefaultUserId) return _cachedDefaultUserId;

  const envId = process.env.SIM_DEFAULT_USER_ID;
  if (envId) {
    _cachedDefaultUserId = envId;
    return envId;
  }

  try {
    const result = await db.query(
      `SELECT id FROM users ORDER BY created_at ASC LIMIT 1`
    );
    if (result.rows[0]?.id) {
      _cachedDefaultUserId = result.rows[0].id;
      logger.info(`Webhook default user resolved to ${_cachedDefaultUserId}`, 'webhook');
      return _cachedDefaultUserId;
    }
  } catch (err) {
    logger.warn(`Default user lookup failed: ${err.message}`, 'webhook');
  }
  return null;
}

/**
 * POST /api/webhooks/tradingview
 * Ingest a TradingView webhook. Does NOT process inline -- pushes to processor queue.
 */
async function receiveTradingViewWebhook(req, res) {
  try {
    assertSimMode();

    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signature = req.headers['x-tradingview-signature'] || req.headers['x-webhook-signature'] || '';
    const userId = await _resolveUserId(req);

    if (!userId && !(req.body.test === true || req.body.type === 'PING')) {
      return res.status(401).json({ error: 'No valid user identity. Provide a JWT token or x-api-key header.' });
    }

    const { event, isDuplicate, isTestPing, isMarketData, marketDataType } = await webhookService.ingest(
      req.body,
      rawBody,
      signature,
      userId
    );

    if (isTestPing) {
      return res.status(200).json({
        message: 'Test ping acknowledged',
        eventId: event.id,
        status: 'TEST_PING',
      });
    }

    if (isMarketData) {
      return res.status(202).json({
        message: `${marketDataType} received and stored`,
        eventId: event.id,
        type: marketDataType,
      });
    }

    if (isDuplicate) {
      return res.status(200).json({
        message: 'Duplicate webhook ignored',
        eventId: event.id,
        status: event.status,
      });
    }

    if (event.status === 'REJECTED') {
      return res.status(422).json({
        message: 'Webhook rejected',
        eventId: event.id,
        reason: event.error_message,
      });
    }

    // Event stored successfully, will be picked up by the processor
    res.status(202).json({
      message: 'Webhook received and queued for processing',
      eventId: event.id,
      status: event.status,
    });
  } catch (error) {
    logger.error(`Webhook ingestion failed: ${error.message}`, 'webhook');
    res.status(500).json({ error: 'Internal webhook processing error' });
  }
}

/**
 * GET /api/webhooks
 * List webhook events for the authenticated user
 */
async function listWebhooks(req, res) {
  try {
    const { status, page, limit } = req.query;
    const result = await webhookService.list({
      userId: req.user.id,
      status,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 25,
    });
    res.json(result);
  } catch (error) {
    logger.error(`List webhooks failed: ${error.message}`, 'webhook');
    res.status(500).json({ error: 'Failed to list webhooks' });
  }
}

/**
 * GET /api/webhooks/stats
 * Get webhook status counts for the authenticated user
 */
async function getWebhookStats(req, res) {
  try {
    const result = await db.query(
      `SELECT status, COUNT(*)::int as count
       FROM webhook_events
       WHERE user_id = $1
       GROUP BY status`,
      [req.user.id]
    );
    const counts = { RECEIVED: 0, PROCESSED: 0, REJECTED: 0, TEST_PING: 0 };
    let total = 0;
    for (const row of result.rows) {
      counts[row.status] = row.count;
      total += row.count;
    }
    counts.total = total;
    res.json(counts);
  } catch (error) {
    logger.error(`Webhook stats failed: ${error.message}`, 'webhook');
    res.status(500).json({ error: 'Failed to get webhook stats' });
  }
}

/**
 * GET /api/webhooks/:id
 * Get a single webhook event
 */
async function getWebhook(req, res) {
  try {
    const event = await webhookService.getById(req.params.id, req.user.id);
    if (!event) {
      return res.status(404).json({ error: 'Webhook event not found' });
    }
    res.json(event);
  } catch (error) {
    logger.error(`Get webhook failed: ${error.message}`, 'webhook');
    res.status(500).json({ error: 'Failed to get webhook' });
  }
}

/**
 * POST /api/webhooks/flow
 * Ingest an options flow event from TradingView.
 */
async function receiveOptionsFlow(req, res) {
  try {
    const userId = await _resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'No valid user identity. Provide a JWT token or x-api-key header.' });
    }
    const flow = await webhookService.ingestOptionsFlow(req.body, userId);
    res.status(202).json({
      message: 'Options flow received',
      flowId: flow.id,
      symbol: flow.symbol,
    });
  } catch (error) {
    logger.error(`Options flow ingestion failed: ${error.message}`, 'webhook');
    res.status(error.message.includes('Missing') ? 422 : 500).json({ error: error.message });
  }
}

/**
 * POST /api/webhooks/price
 * Ingest a price tick from TradingView.
 */
async function receivePriceTick(req, res) {
  try {
    const userId = await _resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'No valid user identity. Provide a JWT token or x-api-key header.' });
    }
    const cached = await webhookService.ingestPriceTick(req.body, userId);
    res.status(202).json({
      message: 'Price tick received',
      symbol: cached.symbol,
      price: cached.price,
    });
  } catch (error) {
    logger.error(`Price tick ingestion failed: ${error.message}`, 'webhook');
    res.status(error.message.includes('Missing') || error.message.includes('invalid') ? 422 : 500).json({ error: error.message });
  }
}

/**
 * POST /api/webhooks/chain
 * Ingest a chain snapshot from TradingView.
 */
async function receiveChainSnapshot(req, res) {
  try {
    const userId = await _resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'No valid user identity. Provide a JWT token or x-api-key header.' });
    }
    const event = await webhookService.ingestChainSnapshot(req.body, userId);
    res.status(202).json({
      message: 'Chain snapshot received',
      eventId: event.id,
      symbol: event.symbol,
    });
  } catch (error) {
    logger.error(`Chain snapshot ingestion failed: ${error.message}`, 'webhook');
    res.status(error.message.includes('Missing') ? 422 : 500).json({ error: error.message });
  }
}

module.exports = {
  receiveTradingViewWebhook,
  receiveOptionsFlow,
  receivePriceTick,
  receiveChainSnapshot,
  listWebhooks,
  getWebhook,
  getWebhookStats,
};
