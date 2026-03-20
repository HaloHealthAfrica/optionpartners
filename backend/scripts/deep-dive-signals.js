#!/usr/bin/env node
'use strict';

const db = require('../src/config/database');

async function run() {
  console.log('\n' + '='.repeat(80));
  console.log('  DEEP DIVE: SIGNALS, FIXES, AND PROFITABILITY');
  console.log('='.repeat(80));

  // 1. Today's trades - full detail
  const trades = await db.query(`
    SELECT id, symbol, strategy, contract_type, side, entry_time, exit_time,
           entry_price, exit_price, quantity, pnl, pnl_percent, exit_reason,
           regime_at_entry, webhook_event_id
    FROM sim_trades
    WHERE entry_time >= CURRENT_DATE AT TIME ZONE 'UTC'
    ORDER BY entry_time ASC
  `);
  console.log('\n--- TODAY\'S 8 TRADES (FULL DETAIL) ---');
  trades.rows.forEach((t, i) => {
    console.log(`\n${i + 1}. ${t.strategy} | ${t.symbol} ${t.contract_type} ${t.side}`);
    console.log(`   Entry: ${t.entry_time} @ $${t.entry_price} x ${t.quantity}`);
    console.log(`   Exit:  ${t.exit_time} @ $${t.exit_price} | ${t.exit_reason || 'N/A'}`);
    console.log(`   P&L: $${parseFloat(t.pnl || 0).toFixed(2)} (${parseFloat(t.pnl_percent || 0).toFixed(1)}%) | Regime: ${t.regime_at_entry || 'N/A'}`);
  });

  // 2. Rejection breakdown - do we have primaryRule sub-categories now?
  const safetyBreakdown = await db.query(`
    SELECT rejection_reason, COUNT(*)::int as cnt
    FROM signal_rejections
    WHERE gate = 'SAFETY_GUARD' AND created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
    GROUP BY rejection_reason ORDER BY cnt DESC
  `);
  console.log('\n--- SAFETY_GUARD REJECTIONS BY SUB-CATEGORY (Fix 2) ---');
  safetyBreakdown.rows.forEach(r => console.log(`  ${r.rejection_reason}: ${r.cnt}`));

  // 3. TRADE_ENGINE rejections - data_staleness vs chain_data_unavailable
  const teBreakdown = await db.query(`
    SELECT rejection_reason, COUNT(*)::int as cnt
    FROM signal_rejections
    WHERE gate = 'TRADE_ENGINE' AND created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
    GROUP BY rejection_reason ORDER BY cnt DESC
  `);
  console.log('\n--- TRADE_ENGINE REJECTIONS (Fix 4 targets) ---');
  teBreakdown.rows.forEach(r => console.log(`  ${r.rejection_reason}: ${r.cnt}`));

  // 4. Sample rejection reasons (raw text) for SAFETY_GUARD
  const safetySamples = await db.query(`
    SELECT reason, rejection_reason, strategy, symbol, created_at
    FROM signal_rejections
    WHERE gate = 'SAFETY_GUARD' AND created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
    ORDER BY created_at DESC LIMIT 10
  `);
  console.log('\n--- SAMPLE SAFETY_GUARD REJECTIONS (last 10) ---');
  safetySamples.rows.forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.rejection_reason}] ${r.strategy} ${r.symbol}`);
    console.log(`     Reason: ${(r.reason || '').slice(0, 100)}...`);
  });

  // 5. Strategy performance today
  const stratPerf = await db.query(`
    SELECT strategy, COUNT(*)::int as trades, SUM(pnl)::numeric as total_pnl,
           COUNT(*) FILTER (WHERE pnl > 0)::int as wins,
           COUNT(*) FILTER (WHERE pnl <= 0)::int as losses
    FROM sim_trades
    WHERE entry_time >= CURRENT_DATE AT TIME ZONE 'UTC'
    GROUP BY strategy ORDER BY total_pnl DESC
  `);
  console.log('\n--- STRATEGY PERFORMANCE TODAY ---');
  stratPerf.rows.forEach(r => {
    const wr = r.trades > 0 ? ((r.wins / r.trades) * 100).toFixed(1) : '0';
    console.log(`  ${r.strategy}: ${r.trades} trades, WR=${wr}%, P&L=$${parseFloat(r.total_pnl || 0).toFixed(2)}`);
  });

  // 6. Exit reasons for losers
  const loserExits = await db.query(`
    SELECT exit_reason, strategy, symbol, pnl
    FROM sim_trades
    WHERE entry_time >= CURRENT_DATE AT TIME ZONE 'UTC' AND pnl <= 0
    ORDER BY pnl ASC
  `);
  console.log('\n--- LOSING TRADES EXIT REASONS ---');
  loserExits.rows.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.strategy} ${r.symbol}: $${parseFloat(r.pnl).toFixed(2)} | Exit: ${r.exit_reason || 'N/A'}`);
  });

  // 7. Time distribution of trades vs rejections
  const hourlyTrades = await db.query(`
    SELECT EXTRACT(HOUR FROM entry_time AT TIME ZONE 'America/New_York')::int as hour_et,
           COUNT(*)::int as cnt
    FROM sim_trades
    WHERE entry_time >= CURRENT_DATE AT TIME ZONE 'UTC'
    GROUP BY 1 ORDER BY 1
  `);
  console.log('\n--- TRADE TIMING (ET hour) ---');
  hourlyTrades.rows.forEach(r => console.log(`  ${r.hour_et}:00 ET: ${r.cnt} trades`));

  // 8. Kill switch / account state
  const acctState = await db.query(`
    SELECT kill_switch_active, daily_pnl, daily_pnl_reset_at
    FROM sim_account_state LIMIT 1
  `);
  console.log('\n--- ACCOUNT STATE ---');
  if (acctState.rows[0]) {
    console.log(`  Kill switch: ${acctState.rows[0].kill_switch_active}`);
    console.log(`  Daily P&L: $${acctState.rows[0].daily_pnl || 0}`);
    console.log(`  Reset at: ${acctState.rows[0].daily_pnl_reset_at}`);
  }

  // 9. When did rejections happen - before or after our fixes would have deployed?
  const rejectionTimeline = await db.query(`
    SELECT DATE_TRUNC('hour', created_at AT TIME ZONE 'America/New_York') as hour_et,
           gate, COUNT(*)::int as cnt
    FROM signal_rejections
    WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
    GROUP BY 1, gate ORDER BY 1, cnt DESC
  `);
  console.log('\n--- REJECTION TIMELINE (first few hours) ---');
  const byHour = {};
  rejectionTimeline.rows.forEach(r => {
    const h = r.hour_et;
    if (!byHour[h]) byHour[h] = {};
    byHour[h][r.gate] = r.cnt;
  });
  Object.entries(byHour).slice(0, 8).forEach(([h, gates]) => {
    console.log(`  ${h}: ${JSON.stringify(gates)}`);
  });

  await db.pool.end();
  console.log('\n' + '='.repeat(80) + '\n');
}

run().catch(e => { console.error(e); process.exit(1); });
