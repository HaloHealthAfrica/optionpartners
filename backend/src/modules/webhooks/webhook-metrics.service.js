'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');

/**
 * Comprehensive webhook processing metrics service.
 * Tracks performance, latency, success rates, and queue health.
 */
class WebhookMetricsService {
  constructor() {
    this._metricsEnabled = process.env.ENABLE_WEBHOOK_METRICS !== 'false';
  }

  /**
   * Record processing start time for a webhook event
   */
  async recordProcessingStart(eventId, stage = 'total') {
    if (!this._metricsEnabled) return;

    try {
      await db.query(
        `INSERT INTO webhook_processing_metrics
         (event_id, stage, started_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (event_id, stage) DO UPDATE SET
           started_at = EXCLUDED.started_at,
           updated_at = NOW()`,
        [eventId, stage]
      );
    } catch (error) {
      logger.error(`Failed to record processing start for ${eventId}: ${error.message}`, 'webhook-metrics');
    }
  }

  /**
   * Record processing completion with latency
   */
  async recordProcessingComplete(eventId, stage = 'total', success = true, errorType = null, metadata = {}) {
    if (!this._metricsEnabled) return;

    try {
      const result = await db.query(
        `UPDATE webhook_processing_metrics
         SET completed_at = NOW(),
             success = $3,
             error_type = $4,
             metadata = $5,
             updated_at = NOW()
         WHERE event_id = $1 AND stage = $2
         RETURNING started_at, completed_at`,
        [eventId, stage, success, errorType, JSON.stringify(metadata)]
      );

      if (result.rows.length > 0) {
        const { started_at, completed_at } = result.rows[0];
        if (started_at && completed_at) {
          const latencyMs = completed_at.getTime() - started_at.getTime();
          await this._updateLatencyStats(stage, latencyMs, success);
        }
      }
    } catch (error) {
      logger.error(`Failed to record processing complete for ${eventId}: ${error.message}`, 'webhook-metrics');
    }
  }

  /**
   * Update rolling latency statistics
   */
  async _updateLatencyStats(stage, latencyMs, success) {
    try {
      await db.query(
        `INSERT INTO webhook_latency_stats
         (stage, success, total_operations, total_latency_ms, min_latency_ms, max_latency_ms, updated_at)
         VALUES ($1, $2, 1, $3, $3, $3, NOW())
         ON CONFLICT (stage, success) DO UPDATE SET
           total_operations = webhook_latency_stats.total_operations + 1,
           total_latency_ms = webhook_latency_stats.total_latency_ms + $3,
           min_latency_ms = LEAST(webhook_latency_stats.min_latency_ms, $3),
           max_latency_ms = GREATEST(webhook_latency_stats.max_latency_ms, $3),
           updated_at = NOW()`,
        [stage, success, latencyMs]
      );
    } catch (error) {
      logger.error(`Failed to update latency stats: ${error.message}`, 'webhook-metrics');
    }
  }

  /**
   * Record queue depth at regular intervals
   */
  async recordQueueDepth(queueSize, processingCapacity = null) {
    if (!this._metricsEnabled) return;

    try {
      await db.query(
        `INSERT INTO webhook_queue_metrics
         (recorded_at, queue_depth, processing_capacity)
         VALUES (NOW(), $1, $2)`,
        [queueSize, processingCapacity]
      );

      // Keep only last 7 days of queue metrics
      await db.query(
        `DELETE FROM webhook_queue_metrics
         WHERE recorded_at < NOW() - INTERVAL '7 days'`
      );
    } catch (error) {
      logger.error(`Failed to record queue depth: ${error.message}`, 'webhook-metrics');
    }
  }

  /**
   * Record error by type and source
   */
  async recordError(errorType, source, userId = null, eventId = null, metadata = {}) {
    if (!this._metricsEnabled) return;

    try {
      await db.query(
        `INSERT INTO webhook_error_metrics
         (error_type, source, user_id, event_id, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [errorType, source, userId, eventId, JSON.stringify(metadata)]
      );
    } catch (error) {
      logger.error(`Failed to record error metrics: ${error.message}`, 'webhook-metrics');
    }
  }

  /**
   * Get comprehensive webhook processing metrics
   */
  async getProcessingMetrics(timeRangeHours = 24) {
    try {
      const timeFilter = `NOW() - INTERVAL '${timeRangeHours} hours'`;

      // Processing latency stats
      const latencyResult = await db.query(
        `SELECT stage, success,
                total_operations,
                ROUND(total_latency_ms::numeric / total_operations, 2) as avg_latency_ms,
                min_latency_ms, max_latency_ms,
                ROUND(total_operations::numeric / ${timeRangeHours}, 2) as operations_per_hour
         FROM webhook_latency_stats
         WHERE updated_at > ${timeFilter}
         ORDER BY stage, success`
      );

      // Queue depth trends
      const queueResult = await db.query(
        `SELECT
           DATE_TRUNC('hour', recorded_at) as hour,
           ROUND(AVG(queue_depth), 2) as avg_queue_depth,
           MAX(queue_depth) as max_queue_depth,
           COUNT(*) as samples
         FROM webhook_queue_metrics
         WHERE recorded_at > ${timeFilter}
         GROUP BY DATE_TRUNC('hour', recorded_at)
         ORDER BY hour DESC
         LIMIT 24`
      );

      // Error rates by type
      const errorResult = await db.query(
        `SELECT error_type, source, COUNT(*) as count
         FROM webhook_error_metrics
         WHERE occurred_at > ${timeFilter}
         GROUP BY error_type, source
         ORDER BY count DESC
         LIMIT 20`
      );

      // Processing success rates
      const successResult = await db.query(
        `SELECT
           DATE_TRUNC('hour', w.received_at) as hour,
           COUNT(*) as total_received,
           COUNT(CASE WHEN w.status = 'PROCESSED' THEN 1 END) as processed,
           COUNT(CASE WHEN w.status = 'REJECTED' THEN 1 END) as rejected,
           ROUND(
             COUNT(CASE WHEN w.status = 'PROCESSED' THEN 1 END)::numeric /
             NULLIF(COUNT(*), 0) * 100, 2
           ) as success_rate_percent
         FROM webhook_events w
         WHERE w.received_at > ${timeFilter}
         GROUP BY DATE_TRUNC('hour', w.received_at)
         ORDER BY hour DESC
         LIMIT 24`
      );

      return {
        latency: latencyResult.rows,
        queueDepth: queueResult.rows,
        errors: errorResult.rows,
        successRates: successResult.rows,
        timeRangeHours,
      };
    } catch (error) {
      logger.error(`Failed to get processing metrics: ${error.message}`, 'webhook-metrics');
      throw error;
    }
  }

  /**
   * Get current queue health status
   */
  async getQueueHealth() {
    try {
      const result = await db.query(
        `SELECT
           COUNT(CASE WHEN status = 'RECEIVED' THEN 1 END) as pending,
           COUNT(CASE WHEN status = 'REJECTED' AND error_message LIKE 'Processing error:%' THEN 1 END) as retryable_errors,
           COUNT(CASE WHEN status = 'REJECTED' AND error_message NOT LIKE 'Processing error:%' THEN 1 END) as permanent_errors,
           COUNT(CASE WHEN processed_at < NOW() - INTERVAL '5 minutes' AND status = 'RECEIVED' THEN 1 END) as stuck_pending,
           MAX(received_at) as oldest_pending
         FROM webhook_events
         WHERE received_at > NOW() - INTERVAL '24 hours'`
      );

      const stats = result.rows[0];

      // Calculate health score (0-100)
      let healthScore = 100;
      if (stats.pending > 10) healthScore -= Math.min(30, stats.pending - 10);
      if (stats.stuck_pending > 0) healthScore -= Math.min(40, stats.stuck_pending * 10);
      if (stats.retryable_errors > 5) healthScore -= Math.min(20, stats.retryable_errors - 5);
      if (stats.permanent_errors > stats.pending * 0.1) healthScore -= 10;

      return {
        ...stats,
        healthScore: Math.max(0, healthScore),
        status: healthScore >= 80 ? 'healthy' : healthScore >= 60 ? 'warning' : 'critical',
      };
    } catch (error) {
      logger.error(`Failed to get queue health: ${error.message}`, 'webhook-metrics');
      throw error;
    }
  }

  /**
   * Clean up old metrics data (keep last 30 days)
   */
  async cleanupOldMetrics() {
    if (!this._metricsEnabled) return;

    try {
      const tables = [
        'webhook_processing_metrics',
        'webhook_latency_stats',
        'webhook_queue_metrics',
        'webhook_error_metrics'
      ];

      for (const table of tables) {
        await db.query(
          `DELETE FROM ${table} WHERE updated_at < NOW() - INTERVAL '30 days'`
        );
      }

      // Reset latency stats periodically (keep rolling 7-day aggregates)
      await db.query(
        `UPDATE webhook_latency_stats
         SET total_operations = GREATEST(total_operations * 0.9, 1),
             total_latency_ms = total_latency_ms * 0.9,
             updated_at = NOW()
         WHERE updated_at < NOW() - INTERVAL '7 days'`
      );

      logger.info('Cleaned up old webhook metrics data', 'webhook-metrics');
    } catch (error) {
      logger.error(`Failed to cleanup old metrics: ${error.message}`, 'webhook-metrics');
    }
  }
}

module.exports = new WebhookMetricsService();