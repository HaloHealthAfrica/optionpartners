'use strict';

const express = require('express');
const router = express.Router();
const { authenticate, optionalAuth } = require('../../middleware/auth');
const webhookController = require('./webhook.controller');

// Capture raw body for signature verification
const captureRawBody = (req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try {
      req.body = JSON.parse(data);
    } catch (e) {
      req.body = {};
    }
    next();
  });
};

// Public webhook endpoint (authenticated via HMAC or optional API key)
router.post('/tradingview', optionalAuth, webhookController.receiveTradingViewWebhook);

// Authenticated endpoints for viewing webhook history
router.get('/', authenticate, webhookController.listWebhooks);
router.get('/:id', authenticate, webhookController.getWebhook);

module.exports = router;
