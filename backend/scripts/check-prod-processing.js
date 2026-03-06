#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    // 1. Recent webhook events
    const events = await pool.query(
      `SELECT id, status, indicator_source,
              raw_payload->>'ticker' as ticker,
              raw_payload->>'symbol' as symbol,
              error_message,
              received_at, processed_at
       FROM webhook_events
       WHERE received_at > NOW() - INTERVAL '30 minutes'
       ORDER BY received_at DESC
       LIMIT 20`
    );
    console.log('=== WEBHOOK EVENTS (last 30 min) ===');
    console.log(`Count: ${events.rows.length}`);
    for (const e of events.rows) {
      const sym = e.ticker || e.symbol || '?';
      console.log(`  ${e.status.padEnd(10)} | ${(e.indicator_source||'?').padEnd(12)} | ${sym.padEnd(6)} | err=${e.error_message || '-'}`);
    }

    // 2. Intelligence verdicts
    const verdicts = await pool.query(
      `SELECT symbol, direction, strategy, intelligence_score,
              allowed, rejection_reason, created_at
       FROM intelligence_verdicts
       WHERE created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC
       LIMIT 20`
    );
    console.log('\n=== INTELLIGENCE VERDICTS (last 30 min) ===');
    console.log(`Count: ${verdicts.rows.length}`);
    for (const v of verdicts.rows) {
      console.log(`  ${v.allowed ? 'ALLOWED' : 'BLOCKED'} | ${v.symbol.padEnd(6)} | ${v.direction || '?'} | ${v.strategy} | score=${v.intelligence_score} | ${v.rejection_reason || '-'}`);
    }

    // 3. Signal rejections
    const rejections = await pool.query(
      `SELECT symbol, strategy, action, gate, reason, created_at
       FROM signal_rejections
       WHERE created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC
       LIMIT 20`
    );
    console.log('\n=== SIGNAL REJECTIONS (last 30 min) ===');
    console.log(`Count: ${rejections.rows.length}`);
    for (const r of rejections.rows) {
      console.log(`  ${r.gate.padEnd(20)} | ${(r.symbol||'?').padEnd(6)} | ${r.strategy} | ${r.reason.substring(0, 80)}`);
    }

    // 4. Sim orders
    const orders = await pool.query(
      `SELECT id, symbol, side, contract_type, strategy, status,
              indicator_source, rejection_reason, created_at
       FROM sim_orders
       WHERE created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC
       LIMIT 10`
    );
    console.log('\n=== SIM ORDERS (last 30 min) ===');
    console.log(`Count: ${orders.rows.length}`);
    for (const o of orders.rows) {
      console.log(`  ${o.status.padEnd(10)} | ${o.symbol.padEnd(6)} | ${o.side} | ${o.contract_type} | ${o.strategy} | src=${o.indicator_source || '?'}`);
    }

    // 5. Strat alerts
    const alerts = await pool.query(
      `SELECT symbol, direction, setup, score, entry, target, stop, created_at
       FROM strat_alerts
       WHERE created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC
       LIMIT 10`
    );
    console.log('\n=== STRAT ALERTS (last 30 min) ===');
    console.log(`Count: ${alerts.rows.length}`);
    for (const a of alerts.rows) {
      console.log(`  ${(a.symbol||'?').padEnd(6)} | ${a.direction || '?'} | ${a.setup || '?'} | score=${a.score} | E=${a.entry} T=${a.target} S=${a.stop}`);
    }

  } catch (err) {
    console.error('Query failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
