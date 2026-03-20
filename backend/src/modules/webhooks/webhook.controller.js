'use strict';

const webhookService = require('./webhook.service');
const rateLimitService = require('./webhook-rate-limit.service');
const webhookMetricsService = require('./webhook-metrics.service');
const { detectIndicatorSource } = require('./indicator-detector');
const db = require('../../config/database');
const Sentry = require('@sentry/node');
const { assertSimMode } = require('../../config/tradingMode');
const logger = require('../../utils/logger');

/**
 * Resolve user ID from req.user (JWT), x-api-key header, or SIM default user.
 * Priority: JWT > API key > SIM_DEFAULT_USER_ID env > first registered user.
 * @returns {Promise<string|null>}
 */
async function _resolveUserId(req) {
  if (req.user?.id) return req.user.id;

  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    try {
      const result = await db.query(
        `SELECT user_id FROM api_keys
         WHERE key_hash = encode(digest($1, 'sha256'), 'hex')
           AND revoked_at IS NULL
           AND is_active = TRUE
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [apiKey]
      );
      if (result.rows[0]?.user_id) return result.rows[0].user_id;
    } catch (err) {
      logger.warn(`API key lookup failed: ${err.message}`, 'webhook');
    }
  }

  // Fallback for unauthenticated webhooks (paper trading convenience)
  return _getDefaultUserId();
}

let _cachedDefaultUserId = null;
let _defaultUserWarningLogged = false;
async function _getDefaultUserId() {
  if (_cachedDefaultUserId) return _cachedDefaultUserId;

  const envId = process.env.SIM_DEFAULT_USER_ID;
  if (envId) {
    _cachedDefaultUserId = envId;
    return envId;
  }

  // In production, refuse to guess the user — require explicit config
  if (process.env.NODE_ENV === 'production') {
    if (!_defaultUserWarningLogged) {
      logger.warn('Unauthenticated webhook rejected: SIM_DEFAULT_USER_ID not set and running in production', 'webhook');
      _defaultUserWarningLogged = true;
    }
    return null;
  }

  try {
    if (!_defaultUserWarningLogged) {
      logger.warn('SIM_DEFAULT_USER_ID not set — falling back to first registered user (development only)', 'webhook');
      _defaultUserWarningLogged = true;
    }
    const result = await db.query(
      `SELECT id FROM users ORDER BY created_at ASC LIMIT 1`
    );
    if (result.rows[0]?.id) {
      _cachedDefaultUserId = result.rows[0].id;
      logger.info(`Webhook default user resolved to ${_cachedDefaultUserId}`, 'webhook');
      return _cachedDefaultUserId;
    }
  } catch (err) {
    logger.warn(`Default user lookup failed: ${err.message}`, 'webhook');
  }
  return null;
}

/**
 * POST /api/webhooks/tradingview
 * Ingest a TradingView webhook. Does NOT process inline -- pushes to processor queue.
 */
async function receiveTradingViewWebhook(req, res) {
  const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
  // Use null for DB when IP is unknown — PostgreSQL INET rejects 'unknown' string
  const clientIPForDb = (clientIP === 'unknown') ? null : clientIP;
  const userAgent = req.headers['user-agent'] || 'unknown';
  let apiKeyId = null;

  try {
    assertSimMode();

    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signature = req.headers['x-tradingview-signature'] || req.headers['x-webhook-signature'] || '';

    // Resolve user ID and API key info for rate limiting
    const userId = await _resolveUserId(req);
    if (req.headers['x-api-key']) {
      try {
        const apiKeyResult = await db.query(
          `SELECT id FROM api_keys
           WHERE key_hash = encode(digest($1, 'sha256'), 'hex')
             AND revoked_at IS NULL
             AND is_active = TRUE`,
          [req.headers['x-api-key']]
        );
        apiKeyId = apiKeyResult.rows[0]?.id;
      } catch (err) {
        logger.warn(`API key lookup failed during rate limit check: ${err.message}`, 'webhook');
      }
    }

    // Rate limiting checks (skip for test pings)
    if (!(req.body.test === true || req.body.type === 'PING')) {
      // Check IP-based rate limit
      const ipLimit = await rateLimitService.checkRateLimit('ip', clientIP);
      if (!ipLimit.allowed) {
        await rateLimitService.recordMetrics('ip', clientIP, userId, 'rate_limited');
        return res.status(429).json({
          error: 'Rate limit exceeded for IP address',
          retryAfter: Math.ceil((ipLimit.resetTime - new Date()) / 1000),
          limit: rateLimitService.RATE_LIMITS.ip.maxRequests,
          windowMs: rateLimitService.RATE_LIMITS.ip.windowMs,
        });
      }

      // Check API key rate limit if using API key
      if (apiKeyId) {
        const apiKeyLimit = await rateLimitService.checkRateLimit('api_key', apiKeyId);
        if (!apiKeyLimit.allowed) {
          await rateLimitService.recordMetrics('api_key', apiKeyId, userId, 'rate_limited');
          return res.status(429).json({
            error: 'Rate limit exceeded for API key',
            retryAfter: Math.ceil((apiKeyLimit.resetTime - new Date()) / 1000),
            limit: rateLimitService.RATE_LIMITS.api_key.maxRequests,
            windowMs: rateLimitService.RATE_LIMITS.api_key.windowMs,
          });
        }
      }

      // Check user rate limit if authenticated
      if (userId && req.user) {
        const userLimit = await rateLimitService.checkRateLimit('user', userId);
        if (!userLimit.allowed) {
          await rateLimitService.recordMetrics('user', userId, userId, 'rate_limited');
          return res.status(429).json({
            error: 'Rate limit exceeded for user',
            retryAfter: Math.ceil((userLimit.resetTime - new Date()) / 1000),
            limit: rateLimitService.RATE_LIMITS.user.maxRequests,
            windowMs: rateLimitService.RATE_LIMITS.user.windowMs,
          });
        }
      }
    }

    if (!userId && !(req.body.test === true || req.body.type === 'PING')) {
      await rateLimitService.recordMetrics('ip', clientIP, null, 'rejected');
      return res.status(401).json({ error: 'No valid user identity. Provide a JWT token or x-api-key header.' });
    }

    // Parse CRT (Candle Range Theory) message format: "SPY CRT BULL: {...}" or "SPY CRT BEAR: {...}"
    // TradingView sends JSON with message field containing the prefix + JSON payload
    let payload = req.body;
    if (payload && typeof payload === 'object') {
      const msg = payload.message || payload.msg || null;
      if (typeof msg === 'string') {
        let jsonStr = null;
        if (msg.includes('CRT BULL:')) {
          jsonStr = msg.split('CRT BULL:')[1]?.trim();
        } else if (msg.includes('CRT BEAR:')) {
          jsonStr = msg.split('CRT BEAR:')[1]?.trim();
        }
        if (jsonStr) {
          try {
            payload = JSON.parse(jsonStr);
          } catch (e) {
            logger.warn(`CRT message parse failed: ${e.message}`, 'webhook');
          }
        }
      }
    }

    const { event, isDuplicate, isTestPing, isMarketData, marketDataType } = await webhookService.ingest(
      payload,
      rawBody,
      signature,
      userId,
      { clientIP: clientIPForDb, userAgent, apiKeyId }
    );

    // Record metrics
    if (isTestPing) {
      await rateLimitService.recordMetrics('ip', clientIP, userId, 'valid');
      return res.status(200).json({
        message: 'Test ping acknowledged',
        eventId: event.id,
        status: 'TEST_PING',
      });
    }

    if (isMarketData) {
      await rateLimitService.recordMetrics('ip', clientIP, userId, 'valid');
      return res.status(202).json({
        message: `${marketDataType} received and stored`,
        eventId: event.id,
        type: marketDataType,
      });
    }

    if (isDuplicate) {
      await rateLimitService.recordMetrics('ip', clientIP, userId, 'valid');
      return res.status(200).json({
        message: 'Duplicate webhook ignored',
        eventId: event.id,
        status: event.status,
      });
    }

    if (event.status === 'REJECTED') {
      await rateLimitService.recordMetrics('ip', clientIP, userId, 'rejected');
      return res.status(422).json({
        message: 'Webhook rejected',
        eventId: event.id,
        reason: event.error_message,
      });
    }

    // Valid webhook accepted
    await rateLimitService.recordMetrics('ip', clientIP, userId, 'valid');

    // Event stored successfully, will be picked up by the processor
    res.status(202).json({
      message: 'Webhook received and queued for processing',
      eventId: event.id,
      status: event.status,
    });
  } catch (error) {
    // Enhanced logging for debugging SIGNALS 500 — visible in fly logs
    let indicatorSource = 'unknown';
    try {
      indicatorSource = req.body && typeof req.body === 'object' ? detectIndicatorSource(req.body) : 'unknown';
    } catch (_) { /* ignore */ }
    logger.error(`Webhook ingestion failed: ${error.message}`, error, 'webhook');
    logger.error(`[SIGNALS_DEBUG] indicator_source=${indicatorSource} payload_keys=${req.body && typeof req.body === 'object' ? Object.keys(req.body).join(',') : 'none'} stack=${error.stack}`, 'webhook');

    Sentry.captureException(error, {
      tags: { module: 'webhook-controller', indicator_source: indicatorSource },
      extra: {
        indicatorSource,
        payloadKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : [],
        ticker: req.body?.ticker || req.body?.symbol,
        errorMessage: error.message,
      },
    });

    // Record failed request metrics
    try {
      await rateLimitService.recordMetrics('ip', clientIP, null, 'rejected');
    } catch (metricsError) {
      logger.error(`Failed to record error metrics: ${metricsError.message}`, 'webhook');
    }

    // Differentiate transient/database errors so callers can retry appropriately
    const msg = error.message.toLowerCase();
    if (msg.includes('connect') || msg.includes('timeout') || msg.includes('database')) {
      return res.status(503).json({ error: 'Temporary webhook ingestion error, please retry later' });
    }

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
    Sentry.captureException(error, { tags: { module: 'webhook-controller' } });
    res.status(500).json({ error: 'Failed to list webhooks' });
  }
}

/**
 * GET /api/webhooks/stats
 * Get webhook status counts for the authenticated user
 */
async function getWebhookStats(req, res) {
  try {
    const result = await db.query(
      `SELECT status, COUNT(*)::int as count
       FROM webhook_events
       WHERE user_id = $1
       GROUP BY status`,
      [req.user.id]
    );
    const counts = { RECEIVED: 0, PROCESSED: 0, REJECTED: 0, TEST_PING: 0 };
    let total = 0;
    for (const row of result.rows) {
      counts[row.status] = row.count;
      total += row.count;
    }
    counts.total = total;
    res.json(counts);
  } catch (error) {
    logger.error(`Webhook stats failed: ${error.message}`, 'webhook');
    Sentry.captureException(error, { tags: { module: 'webhook-controller' } });
    res.status(500).json({ error: 'Failed to get webhook stats' });
  }
}

/**
 * GET /api/webhooks/source-metrics
 * Get webhook source metrics and rate limit status for the authenticated user
 */
async function getWebhookSourceMetrics(req, res) {
  try {
    const userId = req.user.id;

    // Get source metrics
    const metricsResult = await db.query(
      `SELECT source_type, source_identifier, total_requests, valid_requests,
              rejected_requests, rate_limited_requests, last_request_at, first_request_at
       FROM webhook_source_metrics
       WHERE user_id = $1
       ORDER BY last_request_at DESC
       LIMIT 50`,
      [userId]
    );

    // Get current rate limit status for user's IP (if available from recent requests)
    let rateLimitStatus = null;
    const recentIPResult = await db.query(
      `SELECT DISTINCT client_ip
       FROM webhook_events
       WHERE user_id = $1 AND client_ip IS NOT NULL
       ORDER BY received_at DESC
       LIMIT 1`,
      [userId]
    );

    if (recentIPResult.rows[0]?.client_ip) {
      rateLimitStatus = await rateLimitService.getRateLimitStatus('ip', recentIPResult.rows[0].client_ip);
    }

    res.json({
      metrics: metricsResult.rows,
      currentRateLimit: rateLimitStatus,
      limits: {
        ip: rateLimitService.RATE_LIMITS.ip,
        api_key: rateLimitService.RATE_LIMITS.api_key,
        user: rateLimitService.RATE_LIMITS.user,
      },
    });
  } catch (error) {
    logger.error(`Webhook source metrics failed: ${error.message}`, 'webhook');
    Sentry.captureException(error, { tags: { module: 'webhook-controller' } });
    res.status(500).json({ error: 'Failed to get webhook source metrics' });
  }
}

/**
 * GET /api/webhooks/traded-signals
 * List signals that reached the trade decision engine, with verdict + trade outcome.
 */
async function listTradedSignals(req, res) {
  try {
    const { page, limit, outcome } = req.query;
    const pageNum = parseInt(page) || 1;
    const limitNum = Math.min(parseInt(limit) || 25, 100);
    const offset = (pageNum - 1) * limitNum;
    const userId = req.user.id;

    let outcomeFilter = '';
    const params = [userId, limitNum, offset];
    if (outcome === 'traded') {
      outcomeFilter = 'AND iv.allowed = TRUE';
    } else if (outcome === 'blocked') {
      outcomeFilter = 'AND iv.allowed = FALSE';
    }

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           iv.id,
           iv.created_at,
           iv.symbol,
           iv.direction,
           iv.strategy,
           iv.intelligence_score  AS conviction_score,
           iv.allowed             AS traded,
           iv.rejection_reason,
           iv.signal_confidence,
           iv.checks_detail,
           iv.confluence_count,
           iv.flow_alignment,
           we.id                  AS webhook_event_id,
           we.raw_payload,
           we.received_at,
           we.processed_at,
           we.status              AS webhook_status,
           we.error_message,
           st.id                  AS trade_id,
           st.pnl,
           st.pnl_percent,
           st.entry_price,
           st.exit_price,
           st.entry_time,
           st.exit_time,
           st.exit_reason,
           COALESCE(st.contract_type, sp.contract_type) AS contract_type,
           COALESCE(st.strike, sp.strike) AS strike,
           COALESCE(st.expiration, sp.expiration) AS expiration,
           st.dte_at_entry,
           COALESCE(st.delta_at_entry, sp.delta_at_entry) AS delta_at_entry,
           COALESCE(st.side, 'long') AS side,
           st.r_multiple,
           COALESCE(st.strike_short, sp.strike_short) AS strike_short,
           COALESCE(st.strike_long, sp.strike_long) AS strike_long,
           sp.id                  AS position_id,
           (st.id IS NOT NULL OR sp.id IS NOT NULL) AS position_verified,
           sr.gate                AS rejection_gate,
           sr.reason              AS rejection_detail
         FROM intelligence_verdicts iv
         JOIN webhook_events we ON iv.webhook_event_id = we.id
         LEFT JOIN sim_trades st ON st.webhook_event_id = we.id
         LEFT JOIN sim_positions sp ON sp.webhook_event_id = we.id AND sp.status = 'OPEN'
         LEFT JOIN LATERAL (
           SELECT gate, reason FROM signal_rejections
           WHERE webhook_event_id = we.id
           ORDER BY created_at DESC LIMIT 1
         ) sr ON TRUE
         WHERE iv.user_id = $1 ${outcomeFilter}
         ORDER BY iv.created_at DESC
         LIMIT $2 OFFSET $3`,
        params
      ),
      db.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE allowed = TRUE)::int AS traded_count,
           COUNT(*) FILTER (WHERE allowed = FALSE)::int AS blocked_count
         FROM intelligence_verdicts
         WHERE user_id = $1`,
        [userId]
      ),
    ]);

    const counts = countResult.rows[0] || { total: 0, traded_count: 0, blocked_count: 0 };

    res.json({
      signals: dataResult.rows,
      total: outcome === 'traded' ? counts.traded_count
           : outcome === 'blocked' ? counts.blocked_count
           : counts.total,
      traded_count: counts.traded_count,
      blocked_count: counts.blocked_count,
      page: pageNum,
      limit: limitNum,
    });
  } catch (error) {
    logger.error(`List traded signals failed: ${error.message}`, 'webhook');
    Sentry.captureException(error, { tags: { module: 'webhook-controller' } });
    res.status(500).json({ error: 'Failed to list traded signals' });
  }
}

/**
 * GET /api/webhooks/traded-signals/summary
 * Aggregate stats for traded-signals analytics: win rate, P&L, blocker breakdown, strategy performance.
 */
async function getTradedSignalsSummary(req, res) {
  try {
    const userId = req.user.id;

    const [tradedStats, blockersByGate, blockersByStrategy, performanceByStrategy, performanceBySymbol] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*)::int                                         AS total,
           COUNT(*) FILTER (WHERE iv.allowed = TRUE)::int        AS traded_count,
           COUNT(*) FILTER (WHERE iv.allowed = FALSE)::int       AS blocked_count,
           COUNT(*) FILTER (WHERE iv.allowed = TRUE AND st.pnl IS NOT NULL AND st.pnl > 0)::int   AS wins,
           COUNT(*) FILTER (WHERE iv.allowed = TRUE AND st.pnl IS NOT NULL AND st.pnl <= 0)::int  AS losses,
           COUNT(*) FILTER (WHERE iv.allowed = TRUE AND st.pnl IS NULL)::int                      AS open_trades,
           COALESCE(SUM(st.pnl) FILTER (WHERE iv.allowed = TRUE AND st.pnl IS NOT NULL), 0)::numeric(12,2) AS total_pnl,
           COALESCE(AVG(st.pnl) FILTER (WHERE iv.allowed = TRUE AND st.pnl IS NOT NULL), 0)::numeric(12,2) AS avg_pnl,
           COALESCE(MAX(st.pnl) FILTER (WHERE iv.allowed = TRUE AND st.pnl IS NOT NULL), 0)::numeric(12,2) AS best_pnl,
           COALESCE(MIN(st.pnl) FILTER (WHERE iv.allowed = TRUE AND st.pnl IS NOT NULL), 0)::numeric(12,2) AS worst_pnl,
           COALESCE(AVG(iv.intelligence_score) FILTER (WHERE iv.allowed = TRUE), 0)::numeric(6,2)  AS avg_traded_conviction,
           COALESCE(AVG(iv.intelligence_score) FILTER (WHERE iv.allowed = FALSE), 0)::numeric(6,2) AS avg_blocked_conviction
         FROM intelligence_verdicts iv
         LEFT JOIN sim_trades st ON st.webhook_event_id = iv.webhook_event_id
         WHERE iv.user_id = $1`,
        [userId]
      ),

      db.query(
        `SELECT
           COALESCE(sr.gate, 'UNKNOWN') AS gate,
           COUNT(*)::int AS count,
           COALESCE(AVG(iv.intelligence_score), 0)::numeric(6,2) AS avg_conviction
         FROM intelligence_verdicts iv
         LEFT JOIN LATERAL (
           SELECT gate FROM signal_rejections
           WHERE webhook_event_id = iv.webhook_event_id
           ORDER BY created_at DESC LIMIT 1
         ) sr ON TRUE
         WHERE iv.user_id = $1 AND iv.allowed = FALSE
         GROUP BY sr.gate
         ORDER BY count DESC
         LIMIT 10`,
        [userId]
      ),

      db.query(
        `SELECT
           iv.strategy,
           COUNT(*)::int AS blocked_count,
           array_agg(DISTINCT iv.rejection_reason) FILTER (WHERE iv.rejection_reason IS NOT NULL) AS reasons
         FROM intelligence_verdicts iv
         WHERE iv.user_id = $1 AND iv.allowed = FALSE AND iv.strategy IS NOT NULL
         GROUP BY iv.strategy
         ORDER BY blocked_count DESC
         LIMIT 10`,
        [userId]
      ),

      db.query(
        `SELECT
           iv.strategy,
           COUNT(*) FILTER (WHERE iv.allowed = TRUE)::int  AS traded,
           COUNT(*) FILTER (WHERE iv.allowed = FALSE)::int AS blocked,
           COALESCE(SUM(st.pnl) FILTER (WHERE iv.allowed = TRUE AND st.pnl IS NOT NULL), 0)::numeric(12,2) AS pnl,
           COUNT(*) FILTER (WHERE iv.allowed = TRUE AND st.pnl > 0)::int  AS wins,
           COUNT(*) FILTER (WHERE iv.allowed = TRUE AND st.pnl IS NOT NULL)::int AS closed,
           COALESCE(AVG(iv.intelligence_score), 0)::numeric(6,2) AS avg_conviction
         FROM intelligence_verdicts iv
         LEFT JOIN sim_trades st ON st.webhook_event_id = iv.webhook_event_id
         WHERE iv.user_id = $1 AND iv.strategy IS NOT NULL
         GROUP BY iv.strategy
         ORDER BY traded DESC
         LIMIT 15`,
        [userId]
      ),

      db.query(
        `SELECT
           iv.symbol,
           COUNT(*) FILTER (WHERE iv.allowed = TRUE)::int  AS traded,
           COUNT(*) FILTER (WHERE iv.allowed = FALSE)::int AS blocked,
           COALESCE(SUM(st.pnl) FILTER (WHERE iv.allowed = TRUE AND st.pnl IS NOT NULL), 0)::numeric(12,2) AS pnl,
           COUNT(*) FILTER (WHERE iv.allowed = TRUE AND st.pnl > 0)::int AS wins,
           COUNT(*) FILTER (WHERE iv.allowed = TRUE AND st.pnl IS NOT NULL)::int AS closed
         FROM intelligence_verdicts iv
         LEFT JOIN sim_trades st ON st.webhook_event_id = iv.webhook_event_id
         WHERE iv.user_id = $1 AND iv.symbol IS NOT NULL
         GROUP BY iv.symbol
         ORDER BY traded DESC
         LIMIT 15`,
        [userId]
      ),
    ]);

    const s = tradedStats.rows[0] || {};
    const closedTrades = (s.wins || 0) + (s.losses || 0);

    res.json({
      traded: {
        count: s.traded_count || 0,
        wins: s.wins || 0,
        losses: s.losses || 0,
        open_trades: s.open_trades || 0,
        win_rate: closedTrades > 0 ? Number(((s.wins / closedTrades) * 100).toFixed(1)) : null,
        total_pnl: Number(s.total_pnl) || 0,
        avg_pnl: Number(s.avg_pnl) || 0,
        best_pnl: Number(s.best_pnl) || 0,
        worst_pnl: Number(s.worst_pnl) || 0,
        avg_conviction: Number(s.avg_traded_conviction) || 0,
      },
      blocked: {
        count: s.blocked_count || 0,
        avg_conviction: Number(s.avg_blocked_conviction) || 0,
        by_gate: blockersByGate.rows,
        by_strategy: blockersByStrategy.rows,
      },
      total: s.total || 0,
      by_strategy: performanceByStrategy.rows.map(r => ({
        ...r,
        win_rate: r.closed > 0 ? Number(((r.wins / r.closed) * 100).toFixed(1)) : null,
      })),
      by_symbol: performanceBySymbol.rows.map(r => ({
        ...r,
        win_rate: r.closed > 0 ? Number(((r.wins / r.closed) * 100).toFixed(1)) : null,
      })),
    });
  } catch (error) {
    logger.error(`Traded signals summary failed: ${error.message}`, 'webhook');
    Sentry.captureException(error, { tags: { module: 'webhook-controller' } });
    res.status(500).json({ error: 'Failed to get traded signals summary' });
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
    Sentry.captureException(error, { tags: { module: 'webhook-controller' } });
    res.status(500).json({ error: 'Failed to get webhook' });
  }
}

/**
 * POST /api/webhooks/:id/retry
 * Manually requeue a failed webhook event for retry. Only events that have
 * been rejected due to processing errors and have not exceeded the retry
 * limit are eligible.
 */
async function retryWebhook(req, res) {
  try {
    const event = await webhookService.getById(req.params.id, req.user.id);
    if (!event) {
      return res.status(404).json({ error: 'Webhook event not found' });
    }

    const retried = await webhookService.markForRetry(event.id);
    if (!retried) {
      return res.status(400).json({ error: 'Webhook not eligible for retry' });
    }

    res.json({ message: 'Webhook scheduled for retry', eventId: retried.id, retryCount: retried.retry_count });
  } catch (error) {
    logger.error(`Retry webhook failed: ${error.message}`, 'webhook');
    Sentry.captureException(error, { tags: { module: 'webhook-controller' } });
    res.status(500).json({ error: 'Failed to retry webhook event' });
  }
}

/**
 * POST /api/webhooks/flow
 * Ingest an options flow event from TradingView.
 */
async function receiveOptionsFlow(req, res) {
  try {
    const userId = await _resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'No valid user identity. Provide a JWT token or x-api-key header.' });
    }
    const flow = await webhookService.ingestOptionsFlow(req.body, userId);
    res.status(202).json({
      message: 'Options flow received',
      flowId: flow.id,
      symbol: flow.symbol,
    });
  } catch (error) {
    logger.error(`Options flow ingestion failed: ${error.message}`, 'webhook');
    Sentry.captureException(error, { tags: { module: 'webhook-controller' } });
    res.status(error.message.includes('Missing') ? 422 : 500).json({ error: error.message });
  }
}

/**
 * POST /api/webhooks/price
 * Ingest a price tick from TradingView.
 */
async function receivePriceTick(req, res) {
  try {
    const userId = await _resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'No valid user identity. Provide a JWT token or x-api-key header.' });
    }
    const cached = await webhookService.ingestPriceTick(req.body, userId);
    res.status(202).json({
      message: 'Price tick received',
      symbol: cached.symbol,
      price: cached.price,
    });
  } catch (error) {
    logger.error(`Price tick ingestion failed: ${error.message}`, 'webhook');
    Sentry.captureException(error, { tags: { module: 'webhook-controller' } });
    res.status(error.message.includes('Missing') || error.message.includes('invalid') ? 422 : 500).json({ error: error.message });
  }
}

/**
 * POST /api/webhooks/chain
 * Ingest a chain snapshot from TradingView.
 */
async function receiveChainSnapshot(req, res) {
  try {
    const userId = await _resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'No valid user identity. Provide a JWT token or x-api-key header.' });
    }
    const event = await webhookService.ingestChainSnapshot(req.body, userId);
    res.status(202).json({
      message: 'Chain snapshot received',
      eventId: event.id,
      symbol: event.symbol,
    });
  } catch (error) {
    logger.error(`Chain snapshot ingestion failed: ${error.message}`, 'webhook');
    Sentry.captureException(error, { tags: { module: 'webhook-controller' } });
    res.status(error.message.includes('Missing') ? 422 : 500).json({ error: error.message });
  }
}

/**
 * GET /api/webhooks/processing-metrics
 * Get comprehensive webhook processing performance metrics
 */
async function getWebhookProcessingMetrics(req, res) {
  try {
    const { timeRangeHours } = req.query;
    const hours = parseInt(timeRangeHours) || 24;

    const [processingMetrics, queueHealth] = await Promise.all([
      webhookMetricsService.getProcessingMetrics(hours),
      webhookMetricsService.getQueueHealth(),
    ]);

    res.json({
      processing: processingMetrics,
      queueHealth,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`Webhook processing metrics failed: ${error.message}`, 'webhook');
    Sentry.captureException(error, { tags: { module: 'webhook-controller' } });
    res.status(500).json({ error: 'Failed to get webhook processing metrics' });
  }
}

module.exports = {
  receiveTradingViewWebhook,
  receiveOptionsFlow,
  receivePriceTick,
  receiveChainSnapshot,
  listWebhooks,
  listTradedSignals,
  getTradedSignalsSummary,
  getWebhook,
  getWebhookStats,
  getWebhookSourceMetrics,
  getWebhookProcessingMetrics,
  retryWebhook,
};
