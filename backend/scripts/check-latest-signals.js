#!/usr/bin/env node
'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
(async () => {
  // Last 5 SIGNALS webhooks with their status
  const webhooks = await pool.query(`
    SELECT id, indicator_source, raw_payload->>'ticker' as ticker, status, error_message, received_at, processed_at
    FROM webhook_events
    WHERE indicator_source = 'SIGNALS'
      AND received_at >= NOW() - INTERVAL '10 minutes'
    ORDER BY received_at DESC
    LIMIT 10
  `);
  console.log(`LAST 10 MIN SIGNALS WEBHOOKS (${webhooks.rows.length}):`);
  webhooks.rows.forEach(w => {
    const age = Math.round((Date.now() - new Date(w.received_at).getTime()) / 1000);
    console.log(`  [${w.status}] ${w.ticker || 'unknown'} ${age}s ago${w.error_message ? ' — ' + w.error_message.substring(0, 100) : ''}`);
  });

  // Last 5 signal_rejections after our scorecard reset (after 15:47 UTC)
  const rejections = await pool.query(`
    SELECT gate, symbol, reason, created_at
    FROM signal_rejections
    WHERE created_at >= '2026-03-06T15:47:00Z'
    ORDER BY created_at DESC
    LIMIT 10
  `);
  console.log(`\nREJECTIONS AFTER SCORECARD RESET (${rejections.rows.length}):`);
  rejections.rows.forEach(r => {
    console.log(`  [${r.gate}] ${r.symbol}: ${r.reason.substring(0, 120)}`);
  });

  // Intelligence verdicts after our scorecard reset
  const verdicts = await pool.query(`
    SELECT symbol, direction, strategy, intelligence_score, allowed, rejection_reason, created_at
    FROM intelligence_verdicts
    WHERE created_at >= '2026-03-06T15:47:00Z'
    ORDER BY created_at DESC
    LIMIT 10
  `);
  console.log(`\nINTELLIGENCE VERDICTS AFTER RESET (${verdicts.rows.length}):`);
  verdicts.rows.forEach(v => {
    console.log(`  [${v.allowed ? 'ALLOWED' : 'BLOCKED'}] ${v.symbol} ${v.direction} score=${v.intelligence_score}${v.rejection_reason ? ' — ' + v.rejection_reason.substring(0, 100) : ''}`);
  });

  // Latest orders after scorecard reset
  const orders = await pool.query(`
    SELECT id, symbol, side, contract_type, status, rejection_reason, created_at
    FROM sim_orders
    WHERE created_at >= '2026-03-06T15:47:00Z'
    ORDER BY created_at DESC
    LIMIT 10
  `);
  console.log(`\nORDERS AFTER RESET (${orders.rows.length}):`);
  orders.rows.forEach(o => {
    console.log(`  [${o.status}] ${o.side} ${o.symbol} ${o.contract_type}${o.rejection_reason ? ' — ' + o.rejection_reason.substring(0, 80) : ''}`);
  });

  await pool.end();
})();
