'use strict';

const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');
const marubozuService = require('./marubozu.service');
const { assertSimMode } = require('../../config/tradingMode');

/**
 * POST /api/webhooks/marubozu or /api/webhooks/marubozu/:secret
 * Marubozu SIGNAL_BATCH → fan-out webhook_events.
 * If MARUBOZU_WEBHOOK_SECRET is set, path or X-Webhook-Secret must match; otherwise no auth required.
 */
async function receiveMarubozu(req, res) {
  try {
    assertSimMode();

    const pathSecret = req.params.secret || '';
    const headerSecret = req.headers['x-webhook-secret'] || req.headers['X-Webhook-Secret'] || '';
    const auth = marubozuService.validateWebhookSecret(pathSecret, headerSecret);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const clientIPRaw = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
    const clientIP = clientIPRaw === 'unknown' ? null : clientIPRaw;
    const userAgent = req.headers['user-agent'] || 'unknown';

    const body = await marubozuService.ingest(req.body, { clientIP, userAgent });

    return res.status(200).json(body);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      logger.error(`Marubozu ingest failed: ${error.message}`, error, 'marubozu');
      Sentry.captureException(error, { tags: { module: 'marubozu-controller' } });
    }
    if (status === 400) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(status).json({ error: error.message || 'Marubozu ingest failed' });
  }
}

module.exports = {
  receiveMarubozu,
};
