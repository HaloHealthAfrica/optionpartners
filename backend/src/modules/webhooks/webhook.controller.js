'use strict';

const webhookService = require('./webhook.service');
const { assertSimMode } = require('../../config/tradingMode');
const logger = require('../../utils/logger');

/**
 * POST /api/webhooks/tradingview
 * Ingest a TradingView webhook. Does NOT process inline -- pushes to processor queue.
 */
async function receiveTradingViewWebhook(req, res) {
  try {
    assertSimMode();

    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signature = req.headers['x-tradingview-signature'] || req.headers['x-webhook-signature'] || '';
    const userId = req.user?.id || null;

    const { event, isDuplicate } = await webhookService.ingest(
      req.body,
      rawBody,
      signature,
      userId
    );

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

module.exports = {
  receiveTradingViewWebhook,
  listWebhooks,
  getWebhook,
};
