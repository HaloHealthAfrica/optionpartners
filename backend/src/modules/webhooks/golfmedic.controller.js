'use strict';

const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');
const golfmedicService = require('./golfmedic.service');
const { assertSimMode } = require('../../config/tradingMode');

/**
 * POST /api/webhooks/golfmedic or /api/webhooks/golfmedic/:secret
 * TradingView → GolfMedic JSON alerts.
 * If GOLF_MEDIC_WEBHOOK_SECRET is set, path or X-Webhook-Secret must match; otherwise no auth required.
 */
async function receiveGolfMedic(req, res) {
  try {
    assertSimMode();

    const pathSecret = req.params.secret || '';
    const headerSecret = req.headers['x-webhook-secret'] || req.headers['X-Webhook-Secret'] || '';
    const auth = golfmedicService.validateWebhookSecret(pathSecret, headerSecret);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const clientIPRaw = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
    const clientIP = clientIPRaw === 'unknown' ? null : clientIPRaw;
    const userAgent = req.headers['user-agent'] || 'unknown';

    const body = await golfmedicService.ingest(req.body, { clientIP, userAgent });

    return res.status(200).json({
      status: body.status,
      enrichment_status: body.enrichment_status,
      internal_signal_id: body.internal_signal_id,
      signal_hash: body.signal_hash,
      bar_bucket: body.bar_bucket,
      linkage_key: body.linkage_key,
      is_duplicate: body.is_duplicate,
      ...(body.reason ? { reason: body.reason } : {}),
    });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      logger.error(`GolfMedic ingest failed: ${error.message}`, error, 'golfmedic');
      Sentry.captureException(error, { tags: { module: 'golfmedic-controller' } });
    }
    if (status === 400) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(status).json({ error: error.message || 'GolfMedic ingest failed' });
  }
}

module.exports = {
  receiveGolfMedic,
};
