#!/usr/bin/env node
'use strict';

const db = require('../src/config/database');

async function run() {
  const trades = await db.query(`
    SELECT COUNT(*)::int as cnt, COALESCE(SUM(pnl), 0)::numeric as total_pnl, MAX(entry_time) as latest
    FROM sim_trades WHERE entry_time >= CURRENT_DATE AT TIME ZONE 'UTC'
  `);
  const rejections = await db.query(`
    SELECT gate, rejection_reason, COUNT(*)::int as cnt
    FROM signal_rejections WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
    GROUP BY gate, rejection_reason ORDER BY cnt DESC LIMIT 15
  `);
  const orders = await db.query(`
    SELECT status, COUNT(*)::int as cnt FROM sim_orders
    WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
    GROUP BY status
  `);
  const webhooks = await db.query(`
    SELECT indicator_source, status, COUNT(*)::int as cnt
    FROM webhook_events WHERE received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
    GROUP BY indicator_source, status ORDER BY cnt DESC LIMIT 20
  `);

  console.log('\n=== TODAY\'S TRADING SUMMARY ===\n');
  console.log('TRADES TODAY:', trades.rows[0].cnt, '| Total P&L:', trades.rows[0].total_pnl, '| Latest:', trades.rows[0].latest || 'None');
  console.log('\nSIM ORDERS BY STATUS:', orders.rows);
  console.log('\nREJECTIONS (top 15):', rejections.rows);
  console.log('\nWEBHOOKS BY SOURCE/STATUS:', webhooks.rows);
  await db.pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
