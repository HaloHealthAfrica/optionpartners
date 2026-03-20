#!/usr/bin/env node
'use strict';

/**
 * End-to-End Webhook Trade Flow Test
 *
 * Tests the full pipeline:
 *   1. Webhook ingestion (multiple sources)
 *   2. Stale data handling (refresh symbol_state to avoid blocks)
 *   3. Enrichment (chain/price/trend/macro via decision router)
 *   4. Trade entry (ENTRY webhooks → sim_orders → sim_positions)
 *   5. Trade exit (EXIT webhooks → position close → sim_trades)
 *
 * Runs in-process with DB — no HTTP server required.
 * Set SIM_REQUIRE_CHAIN_DATA=false to allow tests when data-service is down.
 *
 * Usage: node backend/scripts/e2e-webhook-trade-flow.js
 */

process.env.SIM_REQUIRE_CHAIN_DATA = process.env.SIM_REQUIRE_CHAIN_DATA || 'false';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
// Allow squeeze_pro and SIGNALS for E2E test (bypass strategy suppression)
process.env.SUPPRESSED_STRATEGIES = process.env.SUPPRESSED_STRATEGIES_E2E || '';

const db = require('../src/config/database');
const webhookService = require('../src/modules/webhooks/webhook.service');
const webhookProcessor = require('../src/modules/sim/webhook-processor');

const TS = () => Math.floor(Date.now() / 1000);
const NONCE = () => `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const TEST_SYMBOLS = ['SPY', 'AMZN', 'NVDA', 'QQQ', 'AAPL'];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function section(title) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(70));
}

async function refreshSymbolState(userId, symbols) {
  for (const sym of symbols) {
    await db.query(
      `INSERT INTO symbol_state (user_id, symbol, macro_updated_at, local_updated_at, chain_updated_at, price_updated_at)
       VALUES ($1, $2, NOW(), NOW(), NOW(), NOW())
       ON CONFLICT (user_id, symbol) DO UPDATE SET
         macro_updated_at = NOW(),
         local_updated_at = NOW(),
         chain_updated_at = NOW(),
         price_updated_at = NOW(),
         updated_at = NOW()`,
      [userId, sym]
    );
  }
  console.log(`  Refreshed symbol_state for: ${symbols.join(', ')} (stale data bypass)`);
}

async function setupTestEnv(userId) {
  await db.query(
    `INSERT INTO sim_account_state (user_id, cash_balance, buying_power, equity, peak_equity)
     VALUES ($1, 100000, 100000, 100000, 100000)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  await db.query(
    `INSERT INTO revenue_target_config (user_id, daily_target, max_trades_per_day, enabled, allowed_trade_types)
     VALUES ($1, 250, 20, false, ARRAY['CREDIT_SPREAD','DEBIT_SPREAD','LEAP','CALL','PUT'])
     ON CONFLICT (user_id) DO UPDATE SET enabled = false`,
    [userId]
  );

  await db.query(
    `UPDATE sim_account_state SET kill_switch_active = false, daily_pnl = 0, daily_pnl_reset_at = CURRENT_DATE WHERE user_id = $1`,
    [userId]
  );

  await refreshSymbolState(userId, TEST_SYMBOLS);
}

// ── Webhook payloads ──

function signalsPayload(symbol = 'SPY') {
  const ts = TS();
  return {
    ticker: symbol,
    signal: { type: 'BULLISH', bar_time: `${ts}-sig`, quality: 'A', ai_score: 8.2 },
    direction: 'LONG',
    score: 82,
    score_breakdown: { total: 82, trend: 25, momentum: 20, volume: 18, pattern: 19 },
    trend: 'BULLISH',
    trend_data: { alignment: 'BULLISH', ema_fast: 591, ema_slow: 588 },
    pattern: 'Bull_Flag',
    entry: { price: 590.50, stop_loss: 587.00, target_1: 594.00, target_2: 597.00 },
    risk: { stop_loss: 587.00, target_1: 594.00 },
    confidence: 78,
    timeframe: '15',
    timestamp: ts,
    _nonce: `${NONCE()}-signals`,
  };
}

function squeezeProEntryPayload(symbol = 'AMZN') {
  const ts = TS();
  return {
    source: 'SQUEEZE_PRO',
    ticker: symbol,
    direction: 'LONG',
    close: 195.80,
    signal_type: 'ENTRY',
    time: String(ts),
    interval: '15',
    squeeze: { compression_score: 78, bars_compressed: 12, squeeze_released: true },
    momentum: { value: 2.5, direction: 'up' },
    trend: { fast_ema: 195.50, slow_ema: 193.80, macro_ema: 190.00, alignment: 'bullish' },
    volume_filter: { current_volume: 1500000, avg_volume_20: 1200000, volume_ratio: 1.25 },
    levels: { entry: 195.80, swing_stop: 192.50, target_1: 199.00, target_2: 202.00 },
    htf: { timeframe: '65', bias: 'bullish' },
    _nonce: `${NONCE()}-sqz-entry`,
  };
}

function squeezeProExitPayload(symbol = 'AMZN') {
  const ts = TS();
  return {
    source: 'SQUEEZE_PRO',
    ticker: symbol,
    direction: 'LONG',
    close: 199.20,
    signal_type: 'EXIT',
    time: String(ts),
    interval: '15',
    exit_reason: 'MOMENTUM_REVERSAL',
    _nonce: `${NONCE()}-sqz-exit`,
  };
}

function pivotMbPayload(symbol = 'NVDA') {
  const ts = TS();
  return {
    source: 'PIVOT_MB',
    symbol,
    side: 'LONG',
    entry_price: 890.50,
    stop_price: 882.00,
    timestamp: ts,
    bar_time: String(ts),
    trigger: 'BREAK_CLOSE',
    confluence_score: 85,
    ema_alignment_score: 78,
    atr_percentile: 72,
    pivot_position: 'AT_S1',
    mother_bar: { high: 892, low: 888, retest_hold: true },
    targets: [897.0, 903.0],
    timeframe: '15',
    _nonce: `${NONCE()}-pivot`,
  };
}

function stratV1Payload(symbol = 'QQQ') {
  const ts = TS();
  return {
    ticker: symbol,
    journal: { engine: 'STRAT_V6_FULL' },
    signal: { side: 'LONG' },
    entry: 510.0,
    target: 515.0,
    stop: 507.0,
    setup: '2-1-2 Rev',
    trend: 'BULLISH',
    score: 7.5,
    components: ['STRAT_SETUP', 'HTF_IGNITION'],
    timeframe: '15',
    timestamp: ts + 1,
    _nonce: `${NONCE()}-strat-v1`,
  };
}

async function runTest(name, payload, userId) {
  const rawBody = JSON.stringify(payload);
  const result = await webhookService.ingest(payload, rawBody, '', userId, {});

  if (result.isTestPing) {
    return { name, status: 'PING', event: result.event };
  }
  if (result.isDuplicate) {
    return { name, status: 'DUPLICATE', event: result.event };
  }

  const event = result.event;
  if (event.status === 'REJECTED') {
    return { name, status: 'REJECTED_INGEST', event, reason: event.error_message };
  }

  const processResult = await webhookProcessor.processEvent(event);
  return {
    name,
    status: processResult.approved ? 'APPROVED' : 'REJECTED',
    approved: processResult.approved,
    executed: processResult.executed,
    reason: processResult.reason,
    orderId: processResult.orderId,
    positionId: processResult.positionId,
    tradeId: processResult.tradeId,
    event,
  };
}

async function main() {
  console.log('\n' + '═'.repeat(72));
  console.log('  E2E WEBHOOK TRADE FLOW TEST');
  console.log('  Webhook → Process → Stale Data → Enrich → Enter → Exit');
  console.log('═'.repeat(72));

  let userId;
  try {
    const r = await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
    userId = r.rows[0]?.id;
    if (!userId) {
      console.error('No users in DB. Create a user first.');
      process.exit(1);
    }
    console.log(`\nUsing user: ${userId}`);
  } catch (e) {
    console.error('DB error:', e.message);
    process.exit(1);
  }

  await setupTestEnv(userId);

  const results = [];
  const rawBody = '{}';

  // ── Test 1: Ping (sanity) ──
  section('Test 1: Webhook Ping');
  const pingResult = await webhookService.ingest({ test: true, type: 'PING' }, '{}', '', userId, {});
  console.log(`  Ping: ${pingResult.isTestPing ? 'OK' : 'FAIL'}`);
  if (!pingResult.isTestPing) {
    console.error('  Ping failed — aborting');
    process.exit(1);
  }

  // ── Test 2: SIGNALS webhook ──
  section('Test 2: SIGNALS webhook (trade trigger)');
  const signals = signalsPayload('SPY');
  const r2 = await runTest('SIGNALS', signals, userId);
  results.push(r2);
  console.log(`  Ingest: ${r2.status}`);
  if (r2.reason) console.log(`  Reason: ${r2.reason}`);
  if (r2.executed) console.log(`  Order: ${r2.orderId} | Position: ${r2.positionId}`);

  // ── Test 3: PIVOT_MB webhook ──
  section('Test 3: PIVOT_MB webhook');
  const pivot = pivotMbPayload('NVDA');
  const r3 = await runTest('PIVOT_MB', pivot, userId);
  results.push(r3);
  console.log(`  Ingest: ${r3.status}`);
  if (r3.reason) console.log(`  Reason: ${r3.reason}`);
  if (r3.executed) console.log(`  Order: ${r3.orderId} | Position: ${r3.positionId}`);

  // ── Test 4: STRAT V1 webhook ──
  section('Test 4: STRAT V1 webhook');
  const strat = stratV1Payload('QQQ');
  const r4 = await runTest('STRAT_V1', strat, userId);
  results.push(r4);
  console.log(`  Ingest: ${r4.status}`);
  if (r4.reason) console.log(`  Reason: ${r4.reason}`);
  if (r4.executed) console.log(`  Order: ${r4.orderId} | Position: ${r4.positionId}`);

  // ── Test 5: SQUEEZE_PRO ENTRY → EXIT (full cycle) ──
  section('Test 5: SQUEEZE_PRO ENTRY → EXIT (full trade cycle)');
  const sqzEntry = squeezeProEntryPayload('AMZN');
  const r5a = await runTest('SQUEEZE_PRO_ENTRY', sqzEntry, userId);
  results.push(r5a);
  console.log(`  ENTRY: ${r5a.status}`);
  if (r5a.reason) console.log(`  Reason: ${r5a.reason}`);
  if (r5a.executed) console.log(`  Order: ${r5a.orderId} | Position: ${r5a.positionId}`);

  if (r5a.executed) {
    await sleep(500);
    const sqzExit = squeezeProExitPayload('AMZN');
    const r5b = await runTest('SQUEEZE_PRO_EXIT', sqzExit, userId);
    results.push(r5b);
    console.log(`  EXIT:  ${r5b.status}`);
    if (r5b.reason) console.log(`  Reason: ${r5b.reason}`);
    if (r5b.executed) console.log(`  Trade closed: ${r5b.tradeId}`);
  } else {
    console.log(`  EXIT: SKIPPED (no position from ENTRY)`);
  }

  // ── Test 6: Second SQUEEZE_PRO ENTRY+EXIT on different symbol ──
  section('Test 6: SQUEEZE_PRO ENTRY+EXIT on SPY');
  await refreshSymbolState(userId, ['SPY']);
  const sqz2Entry = squeezeProEntryPayload('SPY');
  const r6a = await runTest('SQUEEZE_PRO_ENTRY_SPY', sqz2Entry, userId);
  results.push(r6a);
  console.log(`  ENTRY: ${r6a.status}`);
  if (r6a.reason) console.log(`  Reason: ${r6a.reason}`);
  if (r6a.executed) console.log(`  Order: ${r6a.orderId} | Position: ${r6a.positionId}`);

  if (r6a.executed) {
    await sleep(500);
    const sqz2Exit = squeezeProExitPayload('SPY');
    const r6b = await runTest('SQUEEZE_PRO_EXIT_SPY', sqz2Exit, userId);
    results.push(r6b);
    console.log(`  EXIT:  ${r6b.status}`);
    if (r6b.reason) console.log(`  Reason: ${r6b.reason}`);
    if (r6b.executed) console.log(`  Trade closed: ${r6b.tradeId}`);
  }

  // ── Test 7: EXIT SPY position (opened by SIGNALS in Test 2) via SQUEEZE_PRO EXIT ──
  section('Test 7: EXIT SPY (SIGNALS position) via SQUEEZE_PRO EXIT webhook');
  const spyExit = squeezeProExitPayload('SPY');
  const r7 = await runTest('SQUEEZE_PRO_EXIT_SPY_SIGNALS_POS', spyExit, userId);
  results.push(r7);
  console.log(`  EXIT:  ${r7.status}`);
  if (r7.reason) console.log(`  Reason: ${r7.reason}`);
  if (r7.executed) console.log(`  Trade closed: ${r7.tradeId}`);

  // ── Summary ──
  section('RESULTS SUMMARY');
  const approved = results.filter((r) => r.approved === true);
  const executed = results.filter((r) => r.executed === true);
  const rejected = results.filter((r) => r.status === 'REJECTED' || r.status === 'REJECTED_INGEST');

  console.log(`  Total tests: ${results.length}`);
  console.log(`  Approved: ${approved.length}`);
  console.log(`  Executed (order filled): ${executed.length}`);
  console.log(`  Rejected: ${rejected.length}`);

  if (rejected.length > 0) {
    console.log('\n  Rejection reasons:');
    rejected.forEach((r) => console.log(`    - ${r.name}: ${r.reason || r.event?.error_message || 'N/A'}`));
  }

  // ── DB verification ──
  section('DB VERIFICATION');
  const webhooks = await db.query(
    `SELECT indicator_source, status, COUNT(*)::int AS cnt
     FROM webhook_events
     WHERE user_id = $1 AND received_at > NOW() - INTERVAL '5 minutes'
     GROUP BY indicator_source, status
     ORDER BY indicator_source, status`,
    [userId]
  );
  console.log('  Webhooks (last 5 min):');
  webhooks.rows.forEach((r) => console.log(`    ${r.indicator_source} [${r.status}]: ${r.cnt}`));

  const orders = await db.query(
    `SELECT so.symbol, so.side, so.contract_type, so.status, we.indicator_source
     FROM sim_orders so
     JOIN webhook_events we ON we.id = so.webhook_event_id
     WHERE so.user_id = $1 AND so.created_at > NOW() - INTERVAL '5 minutes'
     ORDER BY so.created_at DESC
     LIMIT 15`,
    [userId]
  );
  console.log('\n  Sim orders (last 5 min):');
  if (orders.rows.length > 0) {
    orders.rows.forEach((o) =>
      console.log(`    [${o.status}] ${o.symbol} ${o.side} ${o.contract_type} (${o.indicator_source})`)
    );
  } else {
    console.log('    (none)');
  }

  const trades = await db.query(
    `SELECT st.symbol, st.underlying_symbol, st.strategy, st.entry_price, st.exit_price, st.pnl, st.exit_reason
     FROM sim_trades st
     JOIN webhook_events we ON we.id = st.webhook_event_id
     WHERE st.user_id = $1 AND st.entry_time > NOW() - INTERVAL '5 minutes'
     ORDER BY st.entry_time DESC
     LIMIT 10`,
    [userId]
  );
  console.log('\n  Sim trades (last 5 min):');
  if (trades.rows.length > 0) {
    trades.rows.forEach((t) => {
      const sym = t.underlying_symbol || t.symbol;
      console.log(
        `    ${sym} ${t.strategy} entry=$${t.entry_price} exit=$${t.exit_price || 'N/A'} PnL=$${t.pnl || 'N/A'} ${t.exit_reason || ''}`
      );
    });
  } else {
    console.log('    (none — positions may still be OPEN)');
  }

  console.log('\n' + '═'.repeat(72));
  const hasExecuted = executed.length > 0;
  const hasExit = trades.rows.length > 0;
  console.log(
    hasExecuted && hasExit
      ? '  ✓ E2E PASS: Webhook processing, entry, and exit flow verified'
      : hasExecuted
        ? '  ⚠ PARTIAL: Entries executed; no exits yet (exit monitor or EXIT webhooks may close later)'
        : '  ✗ E2E FAIL: No orders executed — check data-service, staleness, or guards'
  );
  console.log('═'.repeat(72) + '\n');

  await db.pool.end();
  process.exit(hasExecuted ? 0 : 1);
}

main().catch((err) => {
  console.error('\nE2E error:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
