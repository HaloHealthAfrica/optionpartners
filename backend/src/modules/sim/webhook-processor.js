'use strict';

const webhookService = require('../webhooks/webhook.service');
const { detectIndicatorSource } = require('../webhooks/indicator-detector');
const decisionRouter = require('./decision-router');
const executor = require('./executor');
const tradeFinalizer = require('./trade-finalizer');
const ledgerService = require('./ledger.service');
const signalPrioritizer = require('./signal-prioritizer');
const { maybeCreateStratAlertFromWebhook } = require('./strat-alert.service');
const NotificationService = require('../../services/notificationService');
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

    if (event.status !== 'RECEIVED' && event.status !== 'REJECTED') {
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

      // STRAT alert creation — runs before decision routing to persist the alert
      // regardless of whether the trade is approved
      const source = detectIndicatorSource(payload);
      if (source === 'STRAT') {
        maybeCreateStratAlertFromWebhook(payload, event.user_id, event.id)
          .catch(err => logger.error(`STRAT alert creation failed: ${err.message}`, 'webhook-processor'));
      }

      // Step 1: Decision router
      const decision = await decisionRouter.evaluate(payload, event.id, event.user_id);

      if (decision.contextUpdateOnly) {
        await webhookService.markProcessed(event.id);
        return { contextUpdate: true, indicatorSource: decision.indicatorSource };
      }

      if (!decision.approved) {
        await webhookService.markRejected(event.id, decision.reason);
        NotificationService.sendSimSignalNotification(event.user_id, {
          symbol: decision.signal?.symbol, action: decision.signal?.action,
          indicatorSource: decision.indicatorSource, approved: false,
          reason: decision.reason, convictionScore: decision.convictionScore,
        }).catch(() => {});
        return { approved: false, reason: decision.reason };
      }

      // Step 2: Execute via sim executor (handle multi-position exits)
      const intents = decision.orderIntents || [decision.orderIntent];
      const execResults = [];

      NotificationService.sendSimSignalNotification(event.user_id, {
        symbol: decision.signal?.symbol, action: decision.signal?.action,
        indicatorSource: decision.indicatorSource, approved: true,
        convictionScore: decision.convictionScore,
      }).catch(() => {});

      for (const intent of intents) {
        const { order, fill, position } = await executor.simulateOrder(intent, event.user_id);

        if (order.status === 'REJECTED') {
          execResults.push({ orderId: order.id, executed: false, reason: order.rejection_reason });
          continue;
        }

        NotificationService.sendSimOrderFilledNotification(event.user_id, {
          symbol: intent.symbol, side: intent.side, contractType: intent.contractType,
          quantity: intent.quantity, fillPrice: fill?.fill_price, positionId: position?.id,
        }).catch(() => {});

        let trade = null;
        if (position && position.status === 'CLOSED') {
          trade = await tradeFinalizer.finalize(position, parseFloat(fill.fill_price), event.user_id);
          NotificationService.sendSimTradeClosedNotification(event.user_id, {
            symbol: position.symbol, contractType: position.contract_type,
            pnl: trade?.pnl, pnlPercent: trade?.pnl_percent,
            tradeId: trade?.id,
          }).catch(() => {});
        }

        execResults.push({
          executed: true,
          orderId: order.id,
          fillPrice: fill?.fill_price,
          positionId: position?.id,
          tradeId: trade?.id,
        });
      }

      const anyExecuted = execResults.some(r => r.executed);
      if (!anyExecuted) {
        const reasons = execResults.map(r => r.reason).filter(Boolean).join('; ');
        await webhookService.markRejected(event.id, reasons);
        return { approved: true, executed: false, reason: reasons };
      }

      // Step 3: Mark webhook as processed
      await webhookService.markProcessed(event.id);
      this._processedCount++;

      return {
        approved: true,
        executed: true,
        results: execResults,
        orderId: execResults[0]?.orderId,
        fillPrice: execResults[0]?.fillPrice,
        positionId: execResults[0]?.positionId,
        tradeId: execResults[0]?.tradeId,
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
      if ((event.status !== 'RECEIVED' && event.status !== 'REJECTED') || !event.user_id) {
        const result = await this.processEvent(event);
        rejected.push({ eventId: event.id, ...result });
        continue;
      }

      try {
        const payload = typeof event.raw_payload === 'string'
          ? JSON.parse(event.raw_payload)
          : event.raw_payload;

        const batchSource = detectIndicatorSource(payload);
        if (batchSource === 'STRAT') {
          maybeCreateStratAlertFromWebhook(payload, event.user_id, event.id)
            .catch(err => logger.error(`STRAT alert creation failed: ${err.message}`, 'webhook-processor'));
        }

        const decision = await decisionRouter.evaluate(payload, event.id, event.user_id);

        if (decision.contextUpdateOnly) {
          await webhookService.markProcessed(event.id);
          rejected.push({ eventId: event.id, contextUpdate: true, indicatorSource: decision.indicatorSource });
        } else if (decision.approved) {
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
      const intents = decision.orderIntents || [decision.orderIntent];
      const execResults = [];

      NotificationService.sendSimSignalNotification(event.user_id, {
        symbol: decision.signal?.symbol, action: decision.signal?.action,
        indicatorSource: decision.indicatorSource, approved: true,
        convictionScore: decision.convictionScore,
      }).catch(() => {});

      for (const intent of intents) {
        const { order, fill, position } = await executor.simulateOrder(intent, event.user_id);

        if (order.status === 'REJECTED') {
          execResults.push({ orderId: order.id, executed: false, reason: order.rejection_reason });
          continue;
        }

        NotificationService.sendSimOrderFilledNotification(event.user_id, {
          symbol: intent.symbol, side: intent.side, contractType: intent.contractType,
          quantity: intent.quantity, fillPrice: fill?.fill_price, positionId: position?.id,
        }).catch(() => {});

        let trade = null;
        if (position && position.status === 'CLOSED') {
          trade = await tradeFinalizer.finalize(position, parseFloat(fill.fill_price), event.user_id);
          NotificationService.sendSimTradeClosedNotification(event.user_id, {
            symbol: position.symbol, contractType: position.contract_type,
            pnl: trade?.pnl, pnlPercent: trade?.pnl_percent,
            tradeId: trade?.id,
          }).catch(() => {});
        }

        execResults.push({
          executed: true,
          orderId: order.id,
          fillPrice: fill?.fill_price,
          positionId: position?.id,
          tradeId: trade?.id,
        });
      }

      const anyExecuted = execResults.some(r => r.executed);
      if (!anyExecuted) {
        const reasons = execResults.map(r => r.reason).filter(Boolean).join('; ');
        await webhookService.markRejected(event.id, reasons);
        return { approved: true, executed: false, reason: reasons };
      }

      await webhookService.markProcessed(event.id);
      this._processedCount++;

      return {
        approved: true,
        executed: true,
        results: execResults,
        orderId: execResults[0]?.orderId,
        fillPrice: execResults[0]?.fillPrice,
        positionId: execResults[0]?.positionId,
        tradeId: execResults[0]?.tradeId,
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
