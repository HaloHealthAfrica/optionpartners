'use strict';

const Sentry = require('@sentry/node');
const webhookService = require('../webhooks/webhook.service');
const webhookMetricsService = require('../webhooks/webhook-metrics.service');
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

// Context sources should be processed before trade triggers within each batch
// so that state is fresh when trade decisions are evaluated.
const SOURCE_PRIORITY = {
  MTF_BIAS: 0, TREND: 1, SATY_PHASE: 2, MARKET_CONTEXT: 3,
  OPTIONS_FLOW: 4, PRICE_TICK: 5, CHAIN_SNAPSHOT: 6,
};

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
    this._cycleCount = 0;
  }

  /**
   * Process a single webhook event through the full simulation pipeline.
   * Idempotent: re-processing an already PROCESSED event is a no-op.
   */
  async processEvent(event) {
    assertSimMode();

    // Record total processing start
    await webhookMetricsService.recordProcessingStart(event.id, 'total');

    if (event.status !== 'RECEIVED' && event.status !== 'REJECTED') {
      return { skipped: true, reason: `Event status is ${event.status}` };
    }

    // Use SIM_DEFAULT_USER_ID for unassigned webhooks (e.g. legacy/marketplaybook schema)
    let userId = event.user_id;
    if (!userId) {
      userId = process.env.SIM_DEFAULT_USER_ID;
      if (!userId && process.env.NODE_ENV !== 'production') {
        const { rows } = await require('../../config/database').query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
        userId = rows[0]?.id;
      }
      if (!userId) {
        await webhookService.markRejected(event.id, 'No user_id associated with webhook');
        await webhookMetricsService.recordProcessingComplete(event.id, 'total', false, 'no_user_id');
        return { skipped: true, reason: 'No user_id' };
      }
    }

    try {
      const rawPayload = event.raw_payload ?? event.payload;
      const payload = typeof rawPayload === 'string'
        ? JSON.parse(rawPayload)
        : rawPayload;

      const source = detectIndicatorSource(payload);
      await webhookService.setIndicatorSource(event.id, source);

      if (source === 'STRAT') {
        maybeCreateStratAlertFromWebhook(payload, userId, event.id)
          .catch(err => logger.error(`STRAT alert creation failed: ${err.message}`, 'webhook-processor'));
      }

      // Step 1: Decision router
      await webhookMetricsService.recordProcessingStart(event.id, 'decision_router');
      const decision = await decisionRouter.evaluate(payload, event.id, userId);
      await webhookMetricsService.recordProcessingComplete(event.id, 'decision_router', true, null, {
        approved: decision.approved,
        indicatorSource: decision.indicatorSource,
        convictionScore: decision.convictionScore
      });

      if (decision.contextUpdateOnly) {
        await webhookService.markProcessed(event.id);
        await webhookMetricsService.recordProcessingComplete(event.id, 'total', true);
        return { contextUpdate: true, indicatorSource: decision.indicatorSource };
      }

      if (!decision.approved) {
        await webhookService.markRejected(event.id, decision.reason);
        await webhookMetricsService.recordProcessingComplete(event.id, 'total', false, 'decision_rejected', {
          reason: decision.reason
        });
        NotificationService.sendSimSignalNotification(userId, {
          symbol: decision.signal?.symbol, action: decision.signal?.action,
          indicatorSource: decision.indicatorSource, approved: false,
          reason: decision.reason, convictionScore: decision.convictionScore,
        }).catch(() => {});
        return { approved: false, reason: decision.reason };
      }

      // Step 2: Execute via sim executor (handle multi-position exits)
      const intents = decision.orderIntents || [decision.orderIntent];
      const execResults = [];

      NotificationService.sendSimSignalNotification(userId, {
        symbol: decision.signal?.symbol, action: decision.signal?.action,
        indicatorSource: decision.indicatorSource, approved: true,
        convictionScore: decision.convictionScore,
      }).catch(() => {});

      for (const intent of intents) {
        await webhookMetricsService.recordProcessingStart(event.id, 'executor');
        const { order, fill, position } = await executor.simulateOrder(intent, userId);
        await webhookMetricsService.recordProcessingComplete(event.id, 'executor', order.status !== 'REJECTED', null, {
          orderId: order.id,
          executed: order.status !== 'REJECTED',
          symbol: intent.symbol,
          side: intent.side
        });

        if (order.status === 'REJECTED') {
          execResults.push({ orderId: order.id, executed: false, reason: order.rejection_reason });
          continue;
        }

        if (order.status === 'REJECTED') {
          execResults.push({ orderId: order.id, executed: false, reason: order.rejection_reason });
          continue;
        }

        NotificationService.sendSimOrderFilledNotification(userId, {
          symbol: intent.symbol, side: intent.side, contractType: intent.contractType,
          quantity: intent.quantity, fillPrice: fill?.fill_price, positionId: position?.id,
        }).catch(() => {});

        let trade = null;
        if (position && position.status === 'CLOSED') {
          await webhookMetricsService.recordProcessingStart(event.id, 'finalizer');
          trade = await tradeFinalizer.finalize(position, parseFloat(fill.fill_price), userId);
          await webhookMetricsService.recordProcessingComplete(event.id, 'finalizer', true, null, {
            tradeId: trade?.id,
            pnl: trade?.pnl,
            positionId: position.id
          });
          NotificationService.sendSimTradeClosedNotification(userId, {
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
        await webhookMetricsService.recordProcessingComplete(event.id, 'total', false, 'execution_failed', {
          reasons: reasons
        });
        return { approved: true, executed: false, reason: reasons };
      }

      // Step 3: Mark webhook as processed
      await webhookService.markProcessed(event.id);
      this._processedCount++;

      await webhookMetricsService.recordProcessingComplete(event.id, 'total', true, null, {
        orderCount: execResults.length,
        executedCount: execResults.filter(r => r.executed).length
      });

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
      Sentry.captureException(error, {
        tags: { module: 'webhook-processor', eventId: event.id, source: 'processEvent' },
        extra: { userId, rawPayload: event.raw_payload },
      });
      await webhookService.markRejected(event.id, `Processing error: ${error.message}`);
      await webhookMetricsService.recordProcessingComplete(event.id, 'total', false, 'processing_error', {
        error: error.message
      });
      await webhookMetricsService.recordError('processing_error', 'webhook_processor', userId, event.id, {
        error: error.message,
        stack: error.stack
      });
      return { approved: false, reason: error.message };
    }
  }

  /**
   * Process all pending webhook events with signal priority ranking.
   * Phase 2: When multiple signals arrive, score and process highest-priority first.
   */
  async processPending() {
    const pending = await webhookService.getPending(50);
    if (pending.length === 0) {
      // Record empty queue depth
      await webhookMetricsService.recordQueueDepth(0, 50);
      return [];
    }

    // Record initial queue depth
    await webhookMetricsService.recordQueueDepth(pending.length, 50);

    // Sort batch: context sources first, then trade triggers, preserving received_at order within each group
    const getPayload = (e) => {
      const r = e.raw_payload ?? e.payload;
      return typeof r === 'string' ? JSON.parse(r) : r;
    };
    pending.sort((a, b) => {
      const payloadA = getPayload(a);
      const payloadB = getPayload(b);
      const srcA = a._detectedSource || (a._detectedSource = detectIndicatorSource(payloadA));
      const srcB = b._detectedSource || (b._detectedSource = detectIndicatorSource(payloadB));
      const prioA = SOURCE_PRIORITY[srcA] ?? 10;
      const prioB = SOURCE_PRIORITY[srcB] ?? 10;
      if (prioA !== prioB) return prioA - prioB;
      const tsA = a.received_at ?? a.created_at;
      const tsB = b.received_at ?? b.created_at;
      return new Date(tsA) - new Date(tsB);
    });

    // Phase 1: Run all through decision router to get approvals
    const evaluated = [];
    const rejected = [];
    // Batch-aware strike exclusion: so multiple approved entries in same batch pick different strikes
    const batchExcludedStrikes = new Map();

    for (const event of pending) {
      if (event.status !== 'RECEIVED' && event.status !== 'REJECTED') {
        const result = await this.processEvent(event);
        rejected.push({ eventId: event.id, ...result });
        continue;
      }

      // Resolve userId for unassigned webhooks (legacy/marketplaybook schema)
      let batchUserId = event.user_id;
      if (!batchUserId) {
        batchUserId = process.env.SIM_DEFAULT_USER_ID;
        if (!batchUserId && process.env.NODE_ENV !== 'production') {
          const { rows } = await require('../../config/database').query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
          batchUserId = rows[0]?.id;
        }
      }
      if (!batchUserId) {
        const result = await this.processEvent(event);
        rejected.push({ eventId: event.id, ...result });
        continue;
      }
      event._resolvedUserId = batchUserId;

      try {
        const rawPayload = event.raw_payload ?? event.payload;
        const payload = typeof rawPayload === 'string'
          ? JSON.parse(rawPayload)
          : rawPayload;

        const batchSource = detectIndicatorSource(payload);
        await webhookService.setIndicatorSource(event.id, batchSource);

        if (batchSource === 'STRAT') {
          maybeCreateStratAlertFromWebhook(payload, batchUserId, event.id)
            .catch(err => logger.error(`STRAT alert creation failed: ${err.message}`, 'webhook-processor'));
        }

        const decision = await decisionRouter.evaluate(payload, event.id, batchUserId, { batchExcludedStrikes });

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
        Sentry.captureException(error, {
          tags: { module: 'webhook-processor', eventId: event.id, source: 'processPending' },
          extra: { userId: batchUserId },
        });
        await webhookService.markRejected(event.id, `Evaluation error: ${error.message}`);
        rejected.push({ eventId: event.id, approved: false, reason: error.message });
      }
    }

    // Phase 2: Prioritize approved signals per user (not globally)
    const byUser = new Map();
    for (const item of evaluated) {
      const uid = item.event._resolvedUserId || item.event.user_id;
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push(item);
    }

    let prioritized = [];
    for (const [uid, userItems] of byUser) {
      const ranked = await signalPrioritizer.prioritize(userItems, uid);
      prioritized.push(...ranked);
    }

    // Phase 3: Execute in priority order, deduplicating entries per symbol+contractType
    const results = [...rejected];
    const executedEntries = new Set();

    for (const { event, decision, score } of prioritized) {
      const intent = decision.orderIntent;
      if (intent && intent.side === 'BUY' && !intent.positionId) {
        const entryKey = [intent.symbol, intent.contractType, intent.strike, intent.expiration]
          .filter(Boolean).join('|');
        if (executedEntries.has(entryKey)) {
          await webhookService.markRejected(event.id, `Batch dedup: entry already executed for ${entryKey}`);
          results.push({ eventId: event.id, score, approved: true, executed: false, reason: `Batch dedup: ${entryKey}` });
          continue;
        }
        executedEntries.add(entryKey);
      }

      const result = await this._executeApprovedDecision(event, decision, score);
      results.push({ eventId: event.id, score, ...result });
    }

    return results;
  }

  /**
   * Execute an already-approved decision through the sim pipeline.
   */
  async _executeApprovedDecision(event, decision, score) {
    const userId = event._resolvedUserId || event.user_id;
    try {
      const intents = decision.orderIntents || [decision.orderIntent];
      const execResults = [];

      NotificationService.sendSimSignalNotification(userId, {
        symbol: decision.signal?.symbol, action: decision.signal?.action,
        indicatorSource: decision.indicatorSource, approved: true,
        convictionScore: decision.convictionScore,
      }).catch(() => {});

      for (const intent of intents) {
        const { order, fill, position } = await executor.simulateOrder(intent, userId);

        if (order.status === 'REJECTED') {
          execResults.push({ orderId: order.id, executed: false, reason: order.rejection_reason });
          continue;
        }

        NotificationService.sendSimOrderFilledNotification(userId, {
          symbol: intent.symbol, side: intent.side, contractType: intent.contractType,
          quantity: intent.quantity, fillPrice: fill?.fill_price, positionId: position?.id,
        }).catch(() => {});

        let trade = null;
        if (position && position.status === 'CLOSED') {
          trade = await tradeFinalizer.finalize(position, parseFloat(fill.fill_price), userId);
          NotificationService.sendSimTradeClosedNotification(userId, {
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
      Sentry.captureException(error, {
        tags: { module: 'webhook-processor', eventId: event.id, source: 'executeApprovedDecision' },
        extra: { userId },
      });
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

        // Every ~60 cycles (~5 min at 5s interval), run housekeeping
        this._cycleCount++;
        if (this._cycleCount % 60 === 0) {
          await webhookService.escalateDeadLetters();
          await webhookService.cleanupOldEvents(
            parseInt(process.env.WEBHOOK_RETENTION_DAYS || '30', 10)
          );
          // Clean up old metrics data
          await webhookMetricsService.cleanupOldMetrics();
        }
      } catch (error) {
        logger.error(`Processor poll error: ${error.message}`, 'webhook-processor');
        Sentry.captureException(error, { tags: { module: 'webhook-processor', source: 'pollLoop' } });
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
