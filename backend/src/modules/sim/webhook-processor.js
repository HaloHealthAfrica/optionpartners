'use strict';

const webhookService = require('../webhooks/webhook.service');
const decisionRouter = require('./decision-router');
const executor = require('./executor');
const tradeFinalizer = require('./trade-finalizer');
const ledgerService = require('./ledger.service');
const signalPrioritizer = require('./signal-prioritizer');
const logger = require('../../utils/logger');
const { assertSimMode } = require('../../config/tradingMode');

/**
 * Webhook processor -- picks up RECEIVED events and runs them through the sim pipeline.
 * Pipeline: webhook -> decision router -> executor -> trade finalizer
 *
 * Can be run as a polling loop or triggered on-demand.
 */
class WebhookProcessor {
  constructor() {
    this._running = false;
    this._intervalId = null;
    this._processedCount = 0;
  }

  /**
   * Process a single webhook event through the full simulation pipeline.
   * Idempotent: re-processing an already PROCESSED event is a no-op.
   */
  async processEvent(event) {
    assertSimMode();

    if (event.status !== 'RECEIVED') {
      return { skipped: true, reason: `Event status is ${event.status}` };
    }

    if (!event.user_id) {
      await webhookService.markRejected(event.id, 'No user_id associated with webhook');
      return { skipped: true, reason: 'No user_id' };
    }

    try {
      const payload = typeof event.raw_payload === 'string'
        ? JSON.parse(event.raw_payload)
        : event.raw_payload;

      // Step 1: Decision router
      const decision = await decisionRouter.evaluate(payload, event.id, event.user_id);

      if (!decision.approved) {
        await webhookService.markRejected(event.id, decision.reason);
        return { approved: false, reason: decision.reason };
      }

      // Step 2: Execute via sim executor
      const { order, fill, position } = await executor.simulateOrder(decision.orderIntent, event.user_id);

      if (order.status === 'REJECTED') {
        await webhookService.markRejected(event.id, order.rejection_reason);
        return { approved: true, executed: false, reason: order.rejection_reason };
      }

      // Step 3: If position was closed, finalize trade
      let trade = null;
      if (position && position.status === 'CLOSED') {
        trade = await tradeFinalizer.finalize(position, parseFloat(fill.fill_price), event.user_id);
      }

      // Step 4: Mark webhook as processed
      await webhookService.markProcessed(event.id);
      this._processedCount++;

      return {
        approved: true,
        executed: true,
        orderId: order.id,
        fillPrice: fill?.fill_price,
        positionId: position?.id,
        tradeId: trade?.id,
      };
    } catch (error) {
      logger.error(`Processing event ${event.id} failed: ${error.message}`, 'webhook-processor');
      await webhookService.markRejected(event.id, `Processing error: ${error.message}`);
      return { approved: false, reason: error.message };
    }
  }

  /**
   * Process all pending webhook events with signal priority ranking.
   * Phase 2: When multiple signals arrive, score and process highest-priority first.
   */
  async processPending() {
    const pending = await webhookService.getPending(50);
    if (pending.length === 0) return [];

    // Phase 1: Run all through decision router to get approvals
    const evaluated = [];
    const rejected = [];

    for (const event of pending) {
      if (event.status !== 'RECEIVED' || !event.user_id) {
        const result = await this.processEvent(event);
        rejected.push({ eventId: event.id, ...result });
        continue;
      }

      try {
        const payload = typeof event.raw_payload === 'string'
          ? JSON.parse(event.raw_payload)
          : event.raw_payload;

        const decision = await decisionRouter.evaluate(payload, event.id, event.user_id);

        if (decision.approved) {
          evaluated.push({ event, decision });
        } else {
          await webhookService.markRejected(event.id, decision.reason);
          rejected.push({ eventId: event.id, approved: false, reason: decision.reason });
        }
      } catch (error) {
        logger.error(`Decision evaluation failed for ${event.id}: ${error.message}`, 'webhook-processor');
        await webhookService.markRejected(event.id, `Evaluation error: ${error.message}`);
        rejected.push({ eventId: event.id, approved: false, reason: error.message });
      }
    }

    // Phase 2: Prioritize approved signals
    const userId = evaluated.length > 0 ? evaluated[0].event.user_id : null;
    const prioritized = userId
      ? await signalPrioritizer.prioritize(evaluated, userId)
      : evaluated;

    // Phase 3: Execute in priority order
    const results = [...rejected];
    for (const { event, decision, score } of prioritized) {
      const result = await this._executeApprovedDecision(event, decision, score);
      results.push({ eventId: event.id, score, ...result });
    }

    return results;
  }

  /**
   * Execute an already-approved decision through the sim pipeline.
   */
  async _executeApprovedDecision(event, decision, score) {
    try {
      const { order, fill, position } = await executor.simulateOrder(decision.orderIntent, event.user_id);

      if (order.status === 'REJECTED') {
        await webhookService.markRejected(event.id, order.rejection_reason);
        return { approved: true, executed: false, reason: order.rejection_reason };
      }

      let trade = null;
      if (position && position.status === 'CLOSED') {
        trade = await tradeFinalizer.finalize(position, parseFloat(fill.fill_price), event.user_id);
      }

      await webhookService.markProcessed(event.id);
      this._processedCount++;

      return {
        approved: true,
        executed: true,
        orderId: order.id,
        fillPrice: fill?.fill_price,
        positionId: position?.id,
        tradeId: trade?.id,
      };
    } catch (error) {
      logger.error(`Execution failed for ${event.id}: ${error.message}`, 'webhook-processor');
      await webhookService.markRejected(event.id, `Execution error: ${error.message}`);
      return { approved: true, executed: false, reason: error.message };
    }
  }

  /**
   * Start polling for pending events
   */
  start(intervalMs = 5000) {
    if (this._running) return;
    this._running = true;

    logger.info(`Webhook processor started (polling every ${intervalMs}ms)`, 'webhook-processor');

    this._intervalId = setInterval(async () => {
      try {
        await this.processPending();
      } catch (error) {
        logger.error(`Processor poll error: ${error.message}`, 'webhook-processor');
      }
    }, intervalMs);
  }

  /**
   * Stop the polling loop
   */
  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._running = false;
    logger.info('Webhook processor stopped', 'webhook-processor');
  }

  getStatus() {
    return {
      running: this._running,
      processedCount: this._processedCount,
    };
  }
}

module.exports = new WebhookProcessor();
