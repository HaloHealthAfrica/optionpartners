#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
});

async function run() {
  try {
    console.log(JSON.stringify({ _header: 'DAILY_AUDIT', ts: new Date().toISOString() }));

    // 1. Webhook summary for today (UTC)
    const wh = await pool.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'RECEIVED')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
        COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
        COUNT(*) FILTER (WHERE status = 'TEST_PING')::int AS test_pings,
        COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead_letter,
        MIN(received_at) AS first_webhook,
        MAX(received_at) AS last_webhook
      FROM webhook_events
      WHERE received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
    `);
    console.log(JSON.stringify({ section: 'webhook_summary', data: wh.rows[0] }));

    // 2. Webhooks by indicator source
    const whBySource = await pool.query(`
      SELECT indicator_source, status, COUNT(*)::int AS cnt
      FROM webhook_events
      WHERE received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      GROUP BY indicator_source, status
      ORDER BY indicator_source, status
    `);
    console.log(JSON.stringify({ section: 'webhooks_by_source', data: whBySource.rows }));

    // 3. Rejected webhooks with reasons
    const rejectedWh = await pool.query(`
      SELECT id, indicator_source,
             raw_payload->>'ticker' AS ticker,
             raw_payload->>'symbol' AS symbol,
             raw_payload->>'direction' AS direction,
             error_message, received_at, processed_at
      FROM webhook_events
      WHERE received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
        AND status = 'REJECTED'
      ORDER BY received_at DESC
      LIMIT 30
    `);
    console.log(JSON.stringify({ section: 'rejected_webhooks', count: rejectedWh.rowCount, data: rejectedWh.rows }));

    // 4. Signal rejections (gate-level)
    const sigRej = await pool.query(`
      SELECT symbol, strategy, action, gate, reason, created_at
      FROM signal_rejections
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY created_at DESC
      LIMIT 50
    `);
    console.log(JSON.stringify({ section: 'signal_rejections', count: sigRej.rowCount, data: sigRej.rows }));

    // 5. Signal rejections summary by gate
    const sigRejSummary = await pool.query(`
      SELECT gate, COUNT(*)::int AS cnt
      FROM signal_rejections
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      GROUP BY gate
      ORDER BY cnt DESC
    `);
    console.log(JSON.stringify({ section: 'rejection_gates_summary', data: sigRejSummary.rows }));

    // 6. Intelligence verdicts
    const verdicts = await pool.query(`
      SELECT symbol, direction, strategy, intelligence_score,
             allowed, rejection_reason, created_at
      FROM intelligence_verdicts
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY created_at DESC
      LIMIT 50
    `);
    console.log(JSON.stringify({ section: 'intelligence_verdicts', count: verdicts.rowCount, data: verdicts.rows }));

    // 7. Verdicts summary
    const verdictsSummary = await pool.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE allowed = true)::int AS allowed,
        COUNT(*) FILTER (WHERE allowed = false)::int AS blocked,
        AVG(intelligence_score)::numeric(6,2) AS avg_score
      FROM intelligence_verdicts
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
    `);
    console.log(JSON.stringify({ section: 'verdicts_summary', data: verdictsSummary.rows[0] }));

    // 8. Sim orders today
    const orders = await pool.query(`
      SELECT id, symbol, side, contract_type, strategy, indicator_source,
             status, rejection_reason, quantity, limit_price, created_at
      FROM sim_orders
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY created_at DESC
      LIMIT 30
    `);
    console.log(JSON.stringify({ section: 'sim_orders', count: orders.rowCount, data: orders.rows }));

    // 9. Orders summary
    const ordersSummary = await pool.query(`
      SELECT status, COUNT(*)::int AS cnt
      FROM sim_orders
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      GROUP BY status
    `);
    console.log(JSON.stringify({ section: 'orders_summary', data: ordersSummary.rows }));

    // 10. Sim positions (open + closed today)
    const positions = await pool.query(`
      SELECT id, symbol, underlying_symbol, contract_type, strike, expiration,
             quantity, avg_price, current_price, unrealized_pnl, strategy,
             status, opened_at, closed_at
      FROM sim_positions
      WHERE opened_at >= CURRENT_DATE AT TIME ZONE 'UTC'
         OR (closed_at >= CURRENT_DATE AT TIME ZONE 'UTC')
      ORDER BY opened_at DESC
      LIMIT 30
    `);
    console.log(JSON.stringify({ section: 'sim_positions', count: positions.rowCount, data: positions.rows }));

    // 11. Sim trades (finalized P&L)
    const trades = await pool.query(`
      SELECT id, symbol, underlying_symbol, contract_type, side, strategy,
             strike, expiration, entry_price, exit_price, quantity,
             pnl, pnl_percent, r_multiple, entry_time, exit_time,
             exit_reason, stop_source, commission_total
      FROM sim_trades
      WHERE entry_time >= CURRENT_DATE AT TIME ZONE 'UTC'
         OR exit_time >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY COALESCE(exit_time, entry_time) DESC
      LIMIT 30
    `);
    console.log(JSON.stringify({ section: 'sim_trades', count: trades.rowCount, data: trades.rows }));

    // 12. Trade P&L summary
    const tradePnl = await pool.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE exit_time IS NOT NULL)::int AS closed,
        COUNT(*) FILTER (WHERE exit_time IS NULL)::int AS still_open,
        COUNT(*) FILTER (WHERE pnl > 0)::int AS winners,
        COUNT(*) FILTER (WHERE pnl < 0)::int AS losers,
        COUNT(*) FILTER (WHERE pnl = 0)::int AS breakeven,
        COALESCE(SUM(pnl), 0)::numeric(15,2) AS total_pnl,
        COALESCE(AVG(pnl), 0)::numeric(15,2) AS avg_pnl,
        COALESCE(MAX(pnl), 0)::numeric(15,2) AS best_trade,
        COALESCE(MIN(pnl), 0)::numeric(15,2) AS worst_trade,
        COALESCE(SUM(commission_total), 0)::numeric(10,2) AS total_commissions
      FROM sim_trades
      WHERE entry_time >= CURRENT_DATE AT TIME ZONE 'UTC'
         OR exit_time >= CURRENT_DATE AT TIME ZONE 'UTC'
    `);
    console.log(JSON.stringify({ section: 'trade_pnl_summary', data: tradePnl.rows[0] }));

    // 13. Account state
    const acct = await pool.query(`
      SELECT cash_balance, buying_power, equity, unrealized_pnl, realized_pnl,
             peak_equity, max_drawdown, daily_pnl, kill_switch_active, updated_at
      FROM sim_account_state
      LIMIT 1
    `);
    console.log(JSON.stringify({ section: 'account_state', data: acct.rows[0] || null }));

    // 14. Strat alerts today
    const strats = await pool.query(`
      SELECT symbol, direction, setup, score, entry, target, stop, created_at
      FROM strat_alerts
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY created_at DESC
      LIMIT 20
    `);
    console.log(JSON.stringify({ section: 'strat_alerts', count: strats.rowCount, data: strats.rows }));

    // 15. Processed webhooks that led to trades (successful pipeline)
    const successPipeline = await pool.query(`
      SELECT we.id AS webhook_id, we.indicator_source, 
             we.raw_payload->>'ticker' AS ticker,
             we.raw_payload->>'direction' AS direction,
             we.received_at,
             so.id AS order_id, so.side, so.contract_type, so.status AS order_status,
             sp.symbol AS pos_symbol, sp.status AS pos_status, sp.avg_price,
             st.pnl, st.pnl_percent, st.exit_reason
      FROM webhook_events we
      JOIN sim_orders so ON so.webhook_event_id = we.id
      LEFT JOIN sim_positions sp ON sp.webhook_event_id = we.id
      LEFT JOIN sim_trades st ON st.webhook_event_id = we.id
      WHERE we.received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY we.received_at DESC
      LIMIT 30
    `);
    console.log(JSON.stringify({ section: 'success_pipeline', count: successPipeline.rowCount, data: successPipeline.rows }));

    // 16. Strategy cooldowns active
    const cooldowns = await pool.query(`
      SELECT symbol, strategy, cooldown_until, reason, created_at
      FROM strategy_cooldowns
      WHERE cooldown_until > NOW()
      ORDER BY cooldown_until DESC
      LIMIT 10
    `);
    console.log(JSON.stringify({ section: 'active_cooldowns', count: cooldowns.rowCount, data: cooldowns.rows }));

    // 17. Webhook processing latency
    const latency = await pool.query(`
      SELECT 
        AVG(EXTRACT(EPOCH FROM (processed_at - received_at)))::numeric(8,2) AS avg_latency_sec,
        MIN(EXTRACT(EPOCH FROM (processed_at - received_at)))::numeric(8,2) AS min_latency_sec,
        MAX(EXTRACT(EPOCH FROM (processed_at - received_at)))::numeric(8,2) AS max_latency_sec,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (processed_at - received_at)))::numeric(8,2) AS p95_latency_sec
      FROM webhook_events
      WHERE received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
        AND processed_at IS NOT NULL
    `);
    console.log(JSON.stringify({ section: 'processing_latency', data: latency.rows[0] }));

    console.log(JSON.stringify({ _footer: 'AUDIT_COMPLETE' }));
  } catch (err) {
    console.error('AUDIT_ERROR:', err.message, err.hint || '');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
