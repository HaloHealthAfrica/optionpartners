'use strict';

const db = require('../../config/database');
const logger = require('../../utils/logger');

/**
 * Rate limiting configuration
 */
const RATE_LIMITS = {
  // Per IP: 60 requests per minute
  ip: {
    windowMs: 60 * 1000,
    maxRequests: parseInt(process.env.WEBHOOK_RATE_LIMIT_IP_MAX || '60', 10),
  },
  // Per API key: 120 requests per minute
  api_key: {
    windowMs: 60 * 1000,
    maxRequests: parseInt(process.env.WEBHOOK_RATE_LIMIT_API_KEY_MAX || '120', 10),
  },
  // Per user: 300 requests per minute (for authenticated users)
  user: {
    windowMs: 60 * 1000,
    maxRequests: parseInt(process.env.WEBHOOK_RATE_LIMIT_USER_MAX || '300', 10),
  },
};

/**
 * Generate a source key for rate limiting
 * @param {string} type - 'ip', 'api_key', or 'user'
 * @param {string} identifier - IP address, API key ID, or user ID
 * @returns {string}
 */
function generateSourceKey(type, identifier) {
  return `${type}:${identifier}`;
}

/**
 * Check if a request should be rate limited
 * @param {string} sourceType - 'ip', 'api_key', or 'user'
 * @param {string} identifier - The identifier for this source type
 * @returns {Promise<{allowed: boolean, remainingRequests?: number, resetTime?: Date}>}
 */
async function checkRateLimit(sourceType, identifier) {
  const config = RATE_LIMITS[sourceType];
  if (!config) {
    logger.warn(`Unknown rate limit source type: ${sourceType}`, 'webhook-rate-limit');
    return { allowed: true };
  }

  const sourceKey = generateSourceKey(sourceType, identifier);
  const windowStart = new Date(Date.now() - config.windowMs);

  try {
    // Get or create rate limit record for this window
    const result = await db.query(
      `INSERT INTO webhook_rate_limits (source_key, source_type, window_start, request_count, last_request_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (source_key, window_start) DO UPDATE SET
         request_count = webhook_rate_limits.request_count + 1,
         last_request_at = NOW()
       RETURNING request_count`,
      [sourceKey, sourceType, windowStart]
    );

    const currentCount = result.rows[0].request_count;
    const allowed = currentCount <= config.maxRequests;

    if (!allowed) {
      logger.warn(`Rate limit exceeded for ${sourceKey}: ${currentCount}/${config.maxRequests}`, 'webhook-rate-limit');
    }

    return {
      allowed,
      remainingRequests: Math.max(0, config.maxRequests - currentCount),
      resetTime: new Date(windowStart.getTime() + config.windowMs),
    };
  } catch (error) {
    logger.error(`Rate limit check failed for ${sourceKey}: ${error.message}`, 'webhook-rate-limit');
    // On database errors, allow the request to prevent blocking legitimate traffic
    return { allowed: true };
  }
}

/**
 * Record webhook source metrics
 * @param {string} sourceType - 'ip', 'api_key', or 'user'
 * @param {string} identifier - The identifier
 * @param {string} userId - Associated user ID
 * @param {string} status - 'valid', 'rejected', or 'rate_limited'
 */
async function recordMetrics(sourceType, identifier, userId, status) {
  try {
    const updates = {
      total_requests: 1,
      last_request_at: new Date(),
    };

    if (status === 'valid') updates.valid_requests = 1;
    else if (status === 'rejected') updates.rejected_requests = 1;
    else if (status === 'rate_limited') updates.rate_limited_requests = 1;

    await db.query(
      `INSERT INTO webhook_source_metrics
         (source_type, source_identifier, user_id, total_requests, valid_requests, rejected_requests, rate_limited_requests, last_request_at, first_request_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (source_type, source_identifier, user_id) DO UPDATE SET
         total_requests = webhook_source_metrics.total_requests + EXCLUDED.total_requests,
         valid_requests = webhook_source_metrics.valid_requests + EXCLUDED.valid_requests,
         rejected_requests = webhook_source_metrics.rejected_requests + EXCLUDED.rejected_requests,
         rate_limited_requests = webhook_source_metrics.rate_limited_requests + EXCLUDED.rate_limited_requests,
         last_request_at = EXCLUDED.last_request_at,
         updated_at = NOW()`,
      [sourceType, identifier, userId, updates.total_requests, updates.valid_requests || 0, updates.rejected_requests || 0, updates.rate_limited_requests || 0, updates.last_request_at]
    );
  } catch (error) {
    logger.error(`Failed to record webhook metrics: ${error.message}`, 'webhook-metrics');
    // Don't throw - metrics failure shouldn't block webhook processing
  }
}

/**
 * Clean up old rate limit records (older than 1 hour)
 */
async function cleanupOldRecords() {
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    await db.query(
      'DELETE FROM webhook_rate_limits WHERE window_start < $1',
      [cutoff]
    );
    logger.debug('Cleaned up old webhook rate limit records', 'webhook-rate-limit');
  } catch (error) {
    logger.error(`Rate limit cleanup failed: ${error.message}`, 'webhook-rate-limit');
  }
}

/**
 * Get rate limit status for a source
 * @param {string} sourceType
 * @param {string} identifier
 * @returns {Promise<Object|null>}
 */
async function getRateLimitStatus(sourceType, identifier) {
  const sourceKey = generateSourceKey(sourceType, identifier);
  const config = RATE_LIMITS[sourceType];

  if (!config) return null;

  try {
    const result = await db.query(
      `SELECT request_count, window_start, last_request_at
       FROM webhook_rate_limits
       WHERE source_key = $1 AND window_start > $2
       ORDER BY window_start DESC
       LIMIT 1`,
      [sourceKey, new Date(Date.now() - config.windowMs)]
    );

    if (result.rows.length === 0) {
      return {
        currentCount: 0,
        maxRequests: config.maxRequests,
        remainingRequests: config.maxRequests,
        resetTime: new Date(Date.now() + config.windowMs),
      };
    }

    const row = result.rows[0];
    return {
      currentCount: row.request_count,
      maxRequests: config.maxRequests,
      remainingRequests: Math.max(0, config.maxRequests - row.request_count),
      resetTime: new Date(row.window_start.getTime() + config.windowMs),
      lastRequestAt: row.last_request_at,
    };
  } catch (error) {
    logger.error(`Failed to get rate limit status: ${error.message}`, 'webhook-rate-limit');
    return null;
  }
}

module.exports = {
  checkRateLimit,
  recordMetrics,
  cleanupOldRecords,
  getRateLimitStatus,
  RATE_LIMITS,
};