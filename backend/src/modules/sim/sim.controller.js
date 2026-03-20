'use strict';

const ledgerService = require('./ledger.service');
const webhookProcessor = require('./webhook-processor');
const safetyGuards = require('./safety-guards');
const replayService = require('./replay.service');
const symbolStateService = require('./symbol-state.service');
const globalMarketState = require('./global-market-state.service');
const macroRegimeBackfill = require('./macro-regime-backfill.service');
const dataServiceProxy = require('../../services/dataServiceProxy');
const webhookService = require('../webhooks/webhook.service');
const webhookMetricsService = require('../webhooks/webhook-metrics.service');
const rateLimitService = require('../webhooks/webhook-rate-limit.service');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');

/**
 * GET /api/sim/account
 */
async function getAccountState(req, res) {
  try {
    const account = await ledgerService.getAccountState(req.user.id);
    res.json(account);
  } catch (error) {
    logger.error(`Get account state failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to get account state' });
  }
}

/**
 * POST /api/sim/account/reset
 */
async function resetAccount(req, res) {
  try {
    await ledgerService.resetAccount(req.user.id);
    const account = await ledgerService.getAccountState(req.user.id);
    res.json({ message: 'Account reset to initial state', account });
  } catch (error) {
    logger.error(`Reset account failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to reset account' });
  }
}

/**
 * GET /api/sim/positions
 */
async function getPositions(req, res) {
  try {
    const { status, page, limit } = req.query;
    const result = await ledgerService.getPositions(req.user.id, {
      status,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 25,
    });
    res.json(result);
  } catch (error) {
    logger.error(`Get positions failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to get positions' });
  }
}

/**
 * GET /api/sim/orders
 */
async function getOrders(req, res) {
  try {
    const { status, page, limit } = req.query;
    const result = await ledgerService.getOrders(req.user.id, {
      status,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 25,
    });
    res.json(result);
  } catch (error) {
    logger.error(`Get orders failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to get orders' });
  }
}

/**
 * GET /api/sim/trades
 */
async function getTrades(req, res) {
  try {
    const { strategy, symbol, page, limit, startDate, endDate } = req.query;
    const conditions = ['user_id = $1'];
    const params = [req.user.id];
    let idx = 2;

    if (strategy) { conditions.push(`strategy = $${idx++}`); params.push(strategy); }
    if (symbol) { conditions.push(`symbol = $${idx++}`); params.push(symbol.toUpperCase()); }
    if (startDate) { conditions.push(`entry_time >= $${idx++}`); params.push(startDate); }
    if (endDate) { conditions.push(`entry_time <= $${idx++}`); params.push(endDate); }

    const where = conditions.join(' AND ');
    const offset = ((parseInt(page) || 1) - 1) * (parseInt(limit) || 25);

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT * FROM sim_trades WHERE ${where} ORDER BY entry_time DESC LIMIT $${idx++} OFFSET $${idx}`,
        [...params, parseInt(limit) || 25, offset]
      ),
      db.query(`SELECT COUNT(*) as total FROM sim_trades WHERE ${where}`, params),
    ]);

    res.json({
      trades: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 25,
    });
  } catch (error) {
    logger.error(`Get trades failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to get trades' });
  }
}

/**
 * GET /api/sim/equity-curve
 */
async function reconcileWebhookTrades(req, res) {
  try {
    const reconciliationService = require('./reconciliation.service');
    const summary = await reconciliationService.reconcileWebhooksToTrades();
    res.json(summary);
  } catch (error) {
    logger.error(`Reconciliation endpoint failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to run reconciliation' });
  }
}


/**
 * GET /api/sim/equity-curve
 */
async function getEquityCurve(req, res) {
  try {
    const { simRunId, startDate, endDate, limit } = req.query;
    const data = await ledgerService.getEquityCurve(req.user.id, {
      simRunId,
      startDate,
      endDate,
      limit: parseInt(limit) || 500,
    });
    res.json(data);
  } catch (error) {
    logger.error(`Get equity curve failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to get equity curve' });
  }
}

/**
 * GET /api/sim/analytics/strategy
 */
async function getStrategyBreakdown(req, res) {
  try {
    const result = await db.query(
      `SELECT
        strategy,
        COUNT(*) as total_trades,
        COUNT(*) FILTER (WHERE pnl > 0) as winning_trades,
        COUNT(*) FILTER (WHERE pnl <= 0) as losing_trades,
        ROUND(COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as win_rate,
        ROUND(COALESCE(AVG(r_multiple), 0)::numeric, 4) as avg_r_multiple,
        ROUND(SUM(pnl)::numeric, 2) as total_pnl,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl,
        ROUND(MAX(pnl)::numeric, 2) as best_trade,
        ROUND(MIN(pnl)::numeric, 2) as worst_trade,
        ROUND(COALESCE(AVG(dte_at_entry), 0)::numeric, 1) as avg_dte
      FROM sim_trades
      WHERE user_id = $1
      GROUP BY strategy
      ORDER BY total_pnl DESC`,
      [req.user.id]
    );

    // Fetch per-strategy win/loss totals for correct profit factor
    const pfResult = await db.query(
      `SELECT strategy,
              COALESCE(SUM(pnl) FILTER (WHERE pnl > 0), 0) as total_win_pnl,
              ABS(COALESCE(SUM(pnl) FILTER (WHERE pnl <= 0), 0)) as total_loss_pnl
       FROM sim_trades WHERE user_id = $1 GROUP BY strategy`,
      [req.user.id]
    );
    const pfMap = new Map(pfResult.rows.map(r => [r.strategy, r]));

    const strategies = result.rows.map(row => {
      const pf = pfMap.get(row.strategy);
      return {
        ...row,
        profit_factor: pf && parseFloat(pf.total_loss_pnl) > 0
          ? parseFloat(pf.total_win_pnl) / parseFloat(pf.total_loss_pnl)
          : null,
      };
    });

    res.json(strategies);
  } catch (error) {
    logger.error(`Get strategy breakdown failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to get strategy breakdown' });
  }
}

/**
 * GET /api/sim/analytics/dte
 */
async function getDteBreakdown(req, res) {
  try {
    const result = await db.query(
      `SELECT
        CASE
          WHEN dte_at_entry IS NULL THEN 'N/A'
          WHEN dte_at_entry = 0 THEN '0DTE'
          WHEN dte_at_entry BETWEEN 1 AND 2 THEN '1-2DTE'
          WHEN dte_at_entry BETWEEN 3 AND 7 THEN '3-7DTE'
          WHEN dte_at_entry BETWEEN 8 AND 21 THEN '8-21DTE'
          WHEN dte_at_entry BETWEEN 22 AND 45 THEN '22-45DTE'
          ELSE '45+DTE'
        END as dte_bucket,
        COUNT(*) as total_trades,
        COUNT(*) FILTER (WHERE pnl > 0) as winners,
        ROUND(COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as win_rate,
        ROUND(SUM(pnl)::numeric, 2) as total_pnl,
        ROUND(AVG(pnl)::numeric, 2) as avg_pnl
      FROM sim_trades
      WHERE user_id = $1
      GROUP BY dte_bucket
      ORDER BY MIN(COALESCE(dte_at_entry, 9999))`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    logger.error(`Get DTE breakdown failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to get DTE breakdown' });
  }
}

/**
 * POST /api/sim/process
 * Manually trigger processing of pending webhook events
 */
async function processPending(req, res) {
  try {
    const results = await webhookProcessor.processPending();
    res.json({ processed: results.length, results });
  } catch (error) {
    logger.error(`Process pending failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to process pending webhooks' });
  }
}

/**
 * POST /api/sim/kill-switch
 */
async function toggleKillSwitch(req, res) {
  try {
    const { active } = req.body;
    if (active) {
      await safetyGuards.activateKillSwitch(req.user.id);
    } else {
      await safetyGuards.deactivateKillSwitch(req.user.id);
    }
    const account = await ledgerService.getAccountState(req.user.id);
    res.json({ killSwitchActive: account.kill_switch_active, account });
  } catch (error) {
    logger.error(`Toggle kill switch failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to toggle kill switch' });
  }
}

/**
 * POST /api/sim/replay
 */
async function startReplay(req, res) {
  try {
    const { symbol, timeframe, startDate, endDate, strategy, config } = req.body;

    if (!symbol || !timeframe || !startDate || !endDate || !strategy) {
      return res.status(400).json({
        error: 'Missing required fields: symbol, timeframe, startDate, endDate, strategy',
      });
    }

    const run = await replayService.startReplay(req.user.id, {
      symbol, timeframe, startDate, endDate, strategy, config: config || {},
    });

    res.status(202).json({ message: 'Replay started', run });
  } catch (error) {
    logger.error(`Start replay failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to start replay' });
  }
}

/**
 * GET /api/sim/runs
 */
async function getSimRuns(req, res) {
  try {
    const { page, limit } = req.query;
    const offset = ((parseInt(page) || 1) - 1) * (parseInt(limit) || 25);

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT * FROM sim_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.user.id, parseInt(limit) || 25, offset]
      ),
      db.query(`SELECT COUNT(*) as total FROM sim_runs WHERE user_id = $1`, [req.user.id]),
    ]);

    res.json({
      runs: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 25,
    });
  } catch (error) {
    logger.error(`Get sim runs failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to get simulation runs' });
  }
}

/**
 * GET /api/sim/status
 */
async function getStatus(req, res) {
  const processorStatus = webhookProcessor.getStatus();
  const account = await ledgerService.getAccountState(req.user.id).catch(() => null);

  res.json({
    tradingMode: 'SIM',
    processor: processorStatus,
    account: account ? {
      equity: account.equity,
      dailyPnl: account.daily_pnl,
      killSwitchActive: account.kill_switch_active,
    } : null,
  });
}

/**
 * POST /api/sim/warmup/:symbol
 * Seed symbol state with live price + chain data from the data service.
 * Must be called before the first trade for each symbol so that fail-closed
 * checks (price data, chain data) pass.
 */
async function warmupSymbol(req, res) {
  const symbol = (req.params.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

  const userId = req.user.id;
  const results = { symbol, seeded: [] , errors: [] };

  // 1. Seed price data from a quote
  try {
    const quote = await dataServiceProxy.getQuote(symbol);
    const price = quote?.data?.price ?? quote?.data?.last ?? quote?.data?.close;
    if (price) {
      await symbolStateService.update('PRICE_TICK', {
        ticker: symbol,
        price,
        high: quote.data.high,
        low: quote.data.low,
        open: quote.data.open,
        volume: quote.data.volume,
      }, userId, symbol);

      await db.query(
        `INSERT INTO price_cache (symbol, price, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (symbol) DO UPDATE SET price = $2, updated_at = NOW()`,
        [symbol, price]
      );
      results.seeded.push(`price: $${price}`);
    } else {
      results.errors.push('Quote returned no price data');
    }
  } catch (err) {
    results.errors.push(`Quote fetch failed: ${err.message}`);
  }

  // 2. Seed chain data from options chain
  try {
    const chainData = await dataServiceProxy.getOptionsChain(symbol);
    const contracts = chainData?.data?.contracts || [];
    if (contracts.length > 0) {
      await symbolStateService.update('CHAIN_SNAPSHOT', {
        ticker: symbol,
        contracts,
        iv_percentile: chainData.data.iv_percentile || null,
      }, userId, symbol);
      results.seeded.push(`chain: ${contracts.length} contracts`);
    } else {
      results.errors.push('Options chain returned no contracts');
    }
  } catch (err) {
    results.errors.push(`Chain fetch failed: ${err.message}`);
  }

  // 3. Seed macro data — try data-service (VIX/regime) first, fall back to neutral
  try {
    const state = await symbolStateService.getState(userId, symbol);
    if (!state.macro_updated_at) {
      const backfill = await macroRegimeBackfill.refreshFromDataService(userId, symbol);
      if (backfill.refreshed) {
        results.seeded.push(`macro: ${backfill.bias} (data-service)`);
      } else {
        await symbolStateService.update('MTF_BIAS', {
          ticker: symbol,
          mtf: {
            consensus: { bias: 'neutral', weighted_score: 50 },
            regime: { type: 'TREND', chop_score: 20 },
          },
          macro: { state: {} },
          space: {},
          bar: {},
          risk_context: {},
        }, userId, symbol);
        results.seeded.push('macro: NEUTRAL default');
      }
    } else {
      results.seeded.push('macro: already set');
    }
  } catch (err) {
    results.errors.push(`Macro seed failed: ${err.message}`);
  }

  // 4. Ensure sim account exists
  try {
    await ledgerService.getAccountState(userId);
    results.seeded.push('account: ready');
  } catch (err) {
    results.errors.push(`Account init failed: ${err.message}`);
  }

  const ready = results.errors.length === 0;
  const finalState = await symbolStateService.getState(userId, symbol);

  logger.info(`[WARMUP] ${symbol} for user ${userId}: ${results.seeded.join(', ')}`, 'sim');

  res.json({
    ready,
    ...results,
    state: {
      last_price: finalState.last_price,
      price_updated_at: finalState.price_updated_at,
      chain_ok: finalState.chain_ok,
      chain_updated_at: finalState.chain_updated_at,
      macro_bias: finalState.macro_bias,
      regime: finalState.regime,
    },
  });
}

/**
 * GET /api/sim/health/state?symbol=SPY
 * Diagnostic endpoint: shows freshness of every state component for a symbol.
 */
async function getStateHealth(req, res) {
  try {
    const symbol = (req.query.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol query parameter required' });

    const state = await symbolStateService.getState(req.user.id, symbol);
    const STATE_TTL_MS = parseInt(process.env.SIM_STATE_TTL_MS || '1800000', 10);
    const now = Date.now();

    function freshness(updatedAt, ttl = STATE_TTL_MS) {
      if (!updatedAt) return { age_seconds: null, fresh: false, status: 'missing' };
      const ageMs = now - new Date(updatedAt).getTime();
      const ageSec = Math.round(ageMs / 1000);
      const fresh = ageMs <= ttl;
      return { age_seconds: ageSec, fresh, status: fresh ? 'ok' : 'stale' };
    }

    // include kill switch and recent trade frequency
    const account = await ledgerService.getAccountState(req.user.id);
    let recentTrades = null;
    try {
      const r = await db.query(
        `SELECT COUNT(*)::int as cnt FROM sim_trades
         WHERE user_id = $1 AND entry_time > NOW() - INTERVAL '1 minute'`,
        [req.user.id]
      );
      recentTrades = r.rows[0].cnt;
    } catch (_){ recentTrades = null; }

    res.json({
      symbol,
      killSwitch: account?.kill_switch_active || false,
      recentTradesPerMinute: recentTrades,
      macro: {
        bias: state.macro_bias,
        strength: state.macro_strength,
        regime: state.regime,
        ...freshness(state.macro_updated_at),
      },
      trend: {
        bias: state.local_bias,
        alignment_score: state.alignment_score,
        conflict_score: state.conflict_score,
        ...freshness(state.local_updated_at),
      },
      chain: {
        ok: state.chain_ok,
        liquidity_ok: state.liquidity_ok,
        open_interest: state.chain_open_interest,
        bid_ask_spread_pct: state.bid_ask_spread_pct,
        ...freshness(state.chain_updated_at),
      },
      price: {
        last: state.last_price,
        atr: state.atr,
        ...freshness(state.price_updated_at, 5 * 60 * 1000),
      },
      saty: {
        phase: state.latest_saty_signal?.phaseName || null,
        direction: state.latest_saty_signal?.direction || null,
        ...freshness(state.saty_signal_at, 600_000),
      },
      entry_signal: {
        direction: state.latest_entry_signal?.direction || null,
        confidence: state.latest_entry_signal?.confidence || null,
        strategy: state.latest_entry_signal?.strategy || null,
        ...freshness(state.entry_signal_at),
      },
      strat: {
        direction: state.latest_strat_signal?.direction || null,
        setup: state.latest_strat_signal?.setup || null,
        pattern_kind: state.latest_strat_signal?.pattern_kind || null,
        ...freshness(state.strat_signal_at),
      },
      flow: {
        direction: state.latest_flow_signal?.direction || null,
        unusual: state.latest_flow_signal?.unusual || false,
        ...freshness(state.flow_signal_at),
      },
    });
  } catch (error) {
    logger.error(`State health check failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to get state health' });
  }
}

/**
 * POST /api/sim/data-service/circuit-breaker/reset
 * POST /api/sim/connectivity/reset
 * Reset connectivity gate (allows requests to data-service) and optionally
 * data-service's per-provider circuit breakers.
 */
async function resetDataServiceCircuitBreaker(req, res) {
  try {
    const { resetDataService = true } = req.body || {};
    dataServiceProxy.resetConnectivityGate();
    let dataServiceReset = null;
    if (resetDataService) {
      dataServiceReset = await dataServiceProxy.resetDataServiceCircuitBreakers();
    }
    const state = dataServiceProxy.getConnectivityState();
    res.json({
      message: 'Connectivity gate reset',
      connectivity: state,
      dataServiceReset: dataServiceReset?.ok ?? null,
    });
  } catch (error) {
    logger.error(`Reset connectivity gate failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to reset connectivity gate' });
  }
}

/**
 * GET /api/sim/health/global
 * Shows global market state health for all symbols — dead feed detection,
 * staleness, and provider status.
 */
async function getGlobalHealth(_req, res) {
  try {
    const [summary, alerts] = await Promise.all([
      globalMarketState.getHealthSummary(),
      globalMarketState.detectDeadFeeds(),
    ]);

    let dataServiceHealth = null;
    try {
      dataServiceHealth = await dataServiceProxy.getHealth();
    } catch (err) {
      dataServiceHealth = { error: err.message, reachable: false };
    }

    const connectivityState = dataServiceProxy.getConnectivityState();

    res.json({
      globalMarketState: summary,
      deadFeedAlerts: alerts,
      dataService: dataServiceHealth,
      connectivity: connectivityState,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`Global health check failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to get global health' });
  }
}

/**
 * GET /api/sim/webhook-stats
 * Webhook counts for past N days (default 3). For authenticated user.
 * Admin: ?all=true returns global totals across all users.
 * Query: ?days=3
 */
async function getWebhookStats(req, res) {
  try {
    const days = Math.min(parseInt(req.query.days) || 3, 30);
    const isAdmin = req.user.role === 'admin' || req.user.role === 'owner';
    const allUsers = isAdmin && req.query.all === 'true';
    const userId = req.user.id;

    const result = await db.query(
      allUsers
        ? `SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'RECEIVED')::int AS received,
            COUNT(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
            COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
            COUNT(*) FILTER (WHERE status = 'TEST_PING')::int AS test_ping,
            MIN(received_at) AS earliest,
            MAX(received_at) AS latest
           FROM webhook_events
           WHERE received_at >= NOW() - (INTERVAL '1 day' * $1)`
        : `SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'RECEIVED')::int AS received,
            COUNT(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
            COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
            COUNT(*) FILTER (WHERE status = 'TEST_PING')::int AS test_ping,
            MIN(received_at) AS earliest,
            MAX(received_at) AS latest
           FROM webhook_events
           WHERE user_id = $1 AND received_at >= NOW() - (INTERVAL '1 day' * $2)`,
      allUsers ? [days] : [userId, days]
    );

    const row = result.rows[0];
    const stats = {
      days,
      total: row.total,
      received: row.received,
      processed: row.processed,
      rejected: row.rejected,
      testPing: row.test_ping,
      earliest: row.earliest,
      latest: row.latest,
    };

    // Last 10 webhooks for context
    const recent = await db.query(
      allUsers
        ? `SELECT id, received_at, status, indicator_source, error_message, user_id,
                raw_payload->>'symbol' AS symbol, raw_payload->>'ticker' AS ticker
         FROM webhook_events
         WHERE received_at >= NOW() - (INTERVAL '1 day' * $1)
         ORDER BY received_at DESC LIMIT 10`
        : `SELECT id, received_at, status, indicator_source, error_message,
                raw_payload->>'symbol' AS symbol, raw_payload->>'ticker' AS ticker
         FROM webhook_events
         WHERE user_id = $1 AND received_at >= NOW() - (INTERVAL '1 day' * $2)
         ORDER BY received_at DESC LIMIT 10`,
      allUsers ? [days] : [userId, days]
    );
    stats.recent = recent.rows;

    res.json(stats);
  } catch (error) {
    logger.error(`Webhook stats failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to get webhook stats' });
  }
}

/**
 * POST /api/sim/requeue-rejected
 * Admin only. Bulk requeue REJECTED webhooks (processing errors) for retry.
 * Query: ?days=3 (default)
 */
async function bulkRequeueRejected(req, res) {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const days = Math.min(parseInt(req.query.days) || 3, 30);
    const { requeued, ids } = await webhookService.bulkRequeueForRetry(days);
    res.json({ message: `${requeued} webhook(s) requeued for retry`, requeued, ids });
  } catch (error) {
    logger.error(`Bulk requeue failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to requeue webhooks' });
  }
}

/**
 * GET /api/sim/pipeline-observatory
 * Aggregated pipeline observatory data: processor status, gates, rate limit,
 * connectivity, retry/dead-letter, symbol state freshness, processing metrics.
 */
async function getPipelineObservatory(req, res) {
  try {
    const userId = req.user.id;
    const timeRangeHours = parseInt(req.query.timeRangeHours) || 24;

    const [
      processorStatus,
      account,
      positionsResult,
      webhookStats,
      retryStats,
      symbolFreshness,
      processingMetrics,
      queueHealth,
      connectivityState,
      rateLimitData,
    ] = await Promise.all([
      Promise.resolve(webhookProcessor.getStatus()),
      ledgerService.getAccountState(userId).catch(() => null),
      db.query(
        `SELECT COUNT(*)::int AS open_count FROM sim_positions WHERE user_id = $1 AND status = 'OPEN'`,
        [userId]
      ),
      db.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'RECEIVED')::int AS received,
           COUNT(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
           COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
           COUNT(*) FILTER (WHERE status = 'TEST_PING')::int AS test_ping
         FROM webhook_events
         WHERE user_id = $1 AND received_at > NOW() - INTERVAL '1 hour' * $2`,
        [userId, timeRangeHours]
      ),
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'REJECTED' AND error_message LIKE 'Processing error:%' AND COALESCE(retry_count, 0) < 3)::int AS retryable,
           COUNT(*) FILTER (WHERE status = 'REJECTED' AND error_message LIKE 'Processing error:%' AND COALESCE(retry_count, 0) >= 3)::int AS exhausted
         FROM webhook_events
         WHERE user_id = $1 AND received_at > NOW() - INTERVAL '1 hour' * $2`,
        [userId, timeRangeHours]
      ),
      db.query(
        `SELECT symbol, macro_updated_at,
                EXTRACT(EPOCH FROM (NOW() - macro_updated_at)) / 60 AS stale_minutes
         FROM symbol_state
         WHERE user_id = $1 AND macro_updated_at IS NOT NULL
         ORDER BY macro_updated_at ASC
         LIMIT 20`,
        [userId]
      ),
      webhookMetricsService.getProcessingMetrics(timeRangeHours).catch(() => null),
      webhookMetricsService.getQueueHealth().catch(() => null),
      Promise.resolve(dataServiceProxy.getConnectivityState()),
      (async () => {
        const recentIP = await db.query(
          `SELECT client_ip FROM webhook_events WHERE user_id = $1 AND client_ip IS NOT NULL ORDER BY received_at DESC LIMIT 1`,
          [userId]
        );
        const ip = recentIP.rows[0]?.client_ip;
        const rateLimitStatus = ip ? await rateLimitService.getRateLimitStatus('ip', ip) : null;
        return {
          currentRateLimit: rateLimitStatus,
          limits: rateLimitService.RATE_LIMITS,
        };
      })(),
    ]);

    const maxPositions = parseInt(process.env.SIM_MAX_OPEN_POSITIONS || '5', 10);
    const openPositions = positionsResult.rows[0]?.open_count ?? 0;

    res.json({
      processor: processorStatus,
      gates: {
        killSwitchActive: account?.kill_switch_active ?? false,
        openPositions,
        maxPositions,
        atPositionLimit: openPositions >= maxPositions,
      },
      connectivity: connectivityState,
      rateLimit: rateLimitData,
      webhookStats: webhookStats.rows[0] || { total: 0, received: 0, processed: 0, rejected: 0, test_ping: 0 },
      retry: retryStats.rows[0] || { retryable: 0, exhausted: 0 },
      symbolFreshness: symbolFreshness.rows,
      processing: processingMetrics,
      queueHealth: queueHealth || {},
      timeRangeHours,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`Pipeline observatory failed: ${error.message}`, 'sim');
    Sentry.captureException(error, { tags: { module: 'sim-controller' } });
    res.status(500).json({ error: 'Failed to get pipeline observatory' });
  }
}

module.exports = {
  getAccountState,
  resetAccount,
  getPositions,
  getOrders,
  getTrades,
  reconcileWebhookTrades,
  getEquityCurve,
  getStrategyBreakdown,
  getDteBreakdown,
  processPending,
  toggleKillSwitch,
  startReplay,
  getSimRuns,
  getStatus,
  getWebhookStats,
  bulkRequeueRejected,
  warmupSymbol,
  getStateHealth,
  getGlobalHealth,
  resetDataServiceCircuitBreaker,
  getPipelineObservatory,
};
