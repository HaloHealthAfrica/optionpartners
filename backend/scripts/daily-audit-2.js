#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
});

async function run() {
  try {
    // 1. Processing latency for today
    const latency = await pool.query(`
      SELECT 
        AVG(EXTRACT(EPOCH FROM (processed_at - received_at)))::numeric(8,2) AS avg_sec,
        MIN(EXTRACT(EPOCH FROM (processed_at - received_at)))::numeric(8,2) AS min_sec,
        MAX(EXTRACT(EPOCH FROM (processed_at - received_at)))::numeric(8,2) AS max_sec,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (processed_at - received_at)))::numeric(8,2) AS p95_sec
      FROM webhook_events
      WHERE received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
        AND processed_at IS NOT NULL
    `);
    console.log(JSON.stringify({ section: 'latency_today', data: latency.rows[0] }));

    // 2. Active cooldowns
    const cooldowns = await pool.query(`SELECT * FROM strategy_cooldowns WHERE cooldown_until > NOW() ORDER BY cooldown_until DESC LIMIT 10`);
    console.log(JSON.stringify({ section: 'cooldowns', count: cooldowns.rowCount, data: cooldowns.rows }));

    // 3. Currently open positions (from any day)
    const openPos = await pool.query(`
      SELECT id, symbol, underlying_symbol, contract_type, strike, expiration,
             quantity, avg_price, current_price, unrealized_pnl, strategy,
             status, opened_at, closed_at
      FROM sim_positions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 10
    `);
    console.log(JSON.stringify({ section: 'open_positions', count: openPos.rowCount, data: openPos.rows }));

    // 4. March 5 trading session data (yesterday UTC covers 9:30-4PM ET market hours)
    const mar5Webhooks = await pool.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
        COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
      FROM webhook_events
      WHERE received_at >= '2026-03-05 00:00:00+00'
        AND received_at < '2026-03-06 00:00:00+00'
    `);
    console.log(JSON.stringify({ section: 'mar5_webhook_summary', data: mar5Webhooks.rows[0] }));

    // 5. March 5 webhooks by source
    const mar5BySource = await pool.query(`
      SELECT indicator_source, status, COUNT(*)::int AS cnt
      FROM webhook_events
      WHERE received_at >= '2026-03-05 00:00:00+00'
        AND received_at < '2026-03-06 00:00:00+00'
      GROUP BY indicator_source, status
      ORDER BY indicator_source, status
    `);
    console.log(JSON.stringify({ section: 'mar5_by_source', data: mar5BySource.rows }));

    // 6. March 5 orders
    const mar5Orders = await pool.query(`
      SELECT id, symbol, side, contract_type, strategy, indicator_source,
             status, rejection_reason, quantity, created_at
      FROM sim_orders
      WHERE created_at >= '2026-03-05 00:00:00+00'
        AND created_at < '2026-03-06 00:00:00+00'
      ORDER BY created_at DESC LIMIT 30
    `);
    console.log(JSON.stringify({ section: 'mar5_orders', count: mar5Orders.rowCount, data: mar5Orders.rows }));

    // 7. March 5 trades (P&L)
    const mar5Trades = await pool.query(`
      SELECT id, symbol, contract_type, side, strategy, entry_price, exit_price,
             quantity, pnl, pnl_percent, entry_time, exit_time, exit_reason
      FROM sim_trades
      WHERE entry_time >= '2026-03-05 00:00:00+00'
        AND entry_time < '2026-03-06 00:00:00+00'
      ORDER BY entry_time DESC LIMIT 30
    `);
    console.log(JSON.stringify({ section: 'mar5_trades', count: mar5Trades.rowCount, data: mar5Trades.rows }));

    // 8. March 5 signal rejections breakdown
    const mar5Rejections = await pool.query(`
      SELECT gate, reason, COUNT(*)::int AS cnt
      FROM signal_rejections
      WHERE created_at >= '2026-03-05 00:00:00+00'
        AND created_at < '2026-03-06 00:00:00+00'
      GROUP BY gate, reason
      ORDER BY cnt DESC LIMIT 30
    `);
    console.log(JSON.stringify({ section: 'mar5_rejection_breakdown', data: mar5Rejections.rows }));

    // 9. March 5 verdicts summary
    const mar5Verdicts = await pool.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE allowed = true)::int AS allowed,
        COUNT(*) FILTER (WHERE allowed = false)::int AS blocked
      FROM intelligence_verdicts
      WHERE created_at >= '2026-03-05 00:00:00+00'
        AND created_at < '2026-03-06 00:00:00+00'
    `);
    console.log(JSON.stringify({ section: 'mar5_verdicts', data: mar5Verdicts.rows[0] }));

    // 10. All-time trade summary (to understand history)
    const allTrades = await pool.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE pnl > 0)::int AS winners,
        COUNT(*) FILTER (WHERE pnl < 0)::int AS losers,
        COALESCE(SUM(pnl), 0)::numeric(15,2) AS total_pnl,
        MIN(entry_time) AS first_trade,
        MAX(exit_time) AS last_trade
      FROM sim_trades
    `);
    console.log(JSON.stringify({ section: 'all_time_trades', data: allTrades.rows[0] }));

    // 11. Global market state health
    const marketState = await pool.query(`
      SELECT symbol, last_price, price_updated_at, chain_ok, chain_updated_at,
             price_fetch_failures, chain_fetch_failures
      FROM global_market_state ORDER BY symbol LIMIT 20
    `);
    console.log(JSON.stringify({ section: 'market_state', data: marketState.rows }));

    // 12. Recent UNKNOWN webhooks raw payloads (to diagnose format issues)
    const unknownPayloads = await pool.query(`
      SELECT id, raw_payload, received_at
      FROM webhook_events
      WHERE indicator_source = 'UNKNOWN'
        AND received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY received_at DESC LIMIT 5
    `);
    console.log(JSON.stringify({ section: 'unknown_payloads', data: unknownPayloads.rows }));

    console.log(JSON.stringify({ _footer: 'AUDIT2_COMPLETE' }));
  } catch (err) {
    console.error('AUDIT2_ERROR:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
