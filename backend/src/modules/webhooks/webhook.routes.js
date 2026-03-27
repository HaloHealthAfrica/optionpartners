'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticate, optionalAuth } = require('../../middleware/auth');
const webhookController = require('./webhook.controller');
const golfmedicController = require('./golfmedic.controller');
const marubozuController = require('./marubozu.controller');

// Global fallback rate limit (very high) - per-source limiting is now primary
const globalRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.WEBHOOK_RATE_LIMIT_GLOBAL_MAX || '1000', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Global webhook rate limit exceeded. Please contact support if this is unexpected.' },
});

// Public webhook endpoints (authenticated via HMAC or API key)
// Note: Per-source rate limiting is now handled in the controller
function withEmptyPathSecret(handler) {
  return (req, res, next) => {
    if (req.params.secret === undefined) req.params.secret = '';
    return handler(req, res, next);
  };
}
// GolfMedic / Marubozu — secret in env is optional; when set, path and/or X-Webhook-Secret must match
router.post('/golfmedic', globalRateLimit, withEmptyPathSecret(golfmedicController.receiveGolfMedic));
router.post('/golfmedic/:secret', globalRateLimit, golfmedicController.receiveGolfMedic);
router.post('/marubozu', globalRateLimit, withEmptyPathSecret(marubozuController.receiveMarubozu));
router.post('/marubozu/:secret', globalRateLimit, marubozuController.receiveMarubozu);
router.post('/tradingview', globalRateLimit, optionalAuth, webhookController.receiveTradingViewWebhook);
// CRT (Candle Range Theory) alias — same handler, supports "SPY CRT BULL/BEAR: {...}" message format
router.post('/crt-signal', globalRateLimit, optionalAuth, webhookController.receiveTradingViewWebhook);

// Market data webhook endpoints
router.post('/flow', globalRateLimit, optionalAuth, webhookController.receiveOptionsFlow);
router.post('/price', globalRateLimit, optionalAuth, webhookController.receivePriceTick);
router.post('/chain', globalRateLimit, optionalAuth, webhookController.receiveChainSnapshot);

// Authenticated endpoints for viewing webhook history
router.get('/stats', authenticate, webhookController.getWebhookStats);
router.get('/source-metrics', authenticate, webhookController.getWebhookSourceMetrics);
router.get('/processing-metrics', authenticate, webhookController.getWebhookProcessingMetrics);
router.get('/traded-signals/summary', authenticate, webhookController.getTradedSignalsSummary);
router.get('/traded-signals', authenticate, webhookController.listTradedSignals);
router.get('/', authenticate, webhookController.listWebhooks);
router.get('/:id', authenticate, webhookController.getWebhook);

// Allow administrators/users to manually requeue a failed webhook for retry
router.post('/:id/retry', authenticate, webhookController.retryWebhook);

module.exports = router;
