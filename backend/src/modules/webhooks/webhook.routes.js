'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticate, optionalAuth } = require('../../middleware/auth');
const webhookController = require('./webhook.controller');

const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.WEBHOOK_RATE_LIMIT_MAX || '120', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Webhook rate limit exceeded. Max 120 requests per minute.' },
});

// Public webhook endpoints (authenticated via HMAC or API key)
router.post('/tradingview', webhookRateLimit, optionalAuth, webhookController.receiveTradingViewWebhook);

// Market data webhook endpoints
router.post('/flow', webhookRateLimit, optionalAuth, webhookController.receiveOptionsFlow);
router.post('/price', webhookRateLimit, optionalAuth, webhookController.receivePriceTick);
router.post('/chain', webhookRateLimit, optionalAuth, webhookController.receiveChainSnapshot);

// Authenticated endpoints for viewing webhook history
router.get('/stats', authenticate, webhookController.getWebhookStats);
router.get('/', authenticate, webhookController.listWebhooks);
router.get('/:id', authenticate, webhookController.getWebhook);

module.exports = router;
