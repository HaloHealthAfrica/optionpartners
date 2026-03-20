#!/usr/bin/env node
'use strict';

// Allow test without chain data (data-service may be down)
process.env.SIM_REQUIRE_CHAIN_DATA = 'false';

/**
 * Test CRT (Candle Range Theory) webhook flow: ingest → process → trade → exit.
 * Runs without HTTP server — uses webhookService + webhookProcessor directly.
 */

require('dotenv').config();

const db = require('../src/config/database');
const webhookService = require('../src/modules/webhooks/webhook.service');
const webhookProcessor = require('../src/modules/sim/webhook-processor');

const TS = () => new Date().toISOString();
const NONCE = () => `crt_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const CRT_BULL_PAYLOAD = {
  signal_id: NONCE(),
  symbol: 'SPY',
  direction: 'LONG',
  option_type: 'call',
  entry: 585.50,
  stop_loss: 582.00,
  take_profit1: 590.00,
  take_profit2: 592.00,
  take_profit3: 595.00,
  strike: 586,
  dte_suggestion: 7,
  risk_r: 0.5,
  atr: 2.8,
  score: 50,  // >= 40 required for CRT approval
  trigger: '2-1-2',
  sweep: 'LOW',
  timeframe: '5',
  timestamp: TS(),
};

const CRT_BEAR_PAYLOAD = {
  signal_id: NONCE(),
  symbol: 'SPY',
  direction: 'SHORT',
  option_type: 'put',
  entry: 584.00,
  stop_loss: 587.50,
  take_profit1: 578.00,
  take_profit2: 575.00,
  take_profit3: 572.00,
  strike: 583,
  dte_suggestion: 7,
  risk_r: 0.6,
  atr: 2.9,
  score: 45,  // >= 40 required for CRT approval
  trigger: '2-2',
  sweep: 'HIGH',
  timeframe: '15',
  timestamp: TS(),
};

// TradingView message format (as sent by alert)
function wrapCrtMessage(payload, direction) {
  const prefix = direction === 'BULL' ? 'CRT BULL:' : 'CRT BEAR:';
  return { message: `${payload.symbol} ${prefix} ${JSON.stringify(payload)}` };
}

async function run() {
  console.log('\n' + '='.repeat(70));
  console.log('CRT WEBHOOK TEST — Ingest → Process → Trade → Exit');
  console.log('='.repeat(70));

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

  // Ensure sim account exists
  await db.query(
    `INSERT INTO sim_account_state (user_id, cash_balance, buying_power, equity, peak_equity)
     VALUES ($1, 100000, 100000, 100000, 100000)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  // Refresh symbol_state for SPY
  await db.query(
    `INSERT INTO symbol_state (user_id, symbol, macro_updated_at, local_updated_at, chain_updated_at, price_updated_at)
     VALUES ($1, 'SPY', NOW(), NOW(), NOW(), NOW())
     ON CONFLICT (user_id, symbol) DO UPDATE SET
       macro_updated_at = NOW(),
       local_updated_at = NOW(),
       chain_updated_at = NOW(),
       price_updated_at = NOW(),
       updated_at = NOW()`,
    [userId]
  );

  // Disable revenue target for test (or ensure CALL/PUT allowed)
  await db.query(
    `INSERT INTO revenue_target_config (user_id, daily_target, max_trades_per_day, enabled, allowed_trade_types)
     VALUES ($1, 250, 10, false, ARRAY['CREDIT_SPREAD','DEBIT_SPREAD','LEAP','CALL','PUT'])
     ON CONFLICT (user_id) DO UPDATE SET enabled = false`,
    [userId]
  );

  // Deactivate kill switch and reset daily PnL for test
  await db.query(
    `UPDATE sim_account_state SET kill_switch_active = false, daily_pnl = 0, daily_pnl_reset_at = CURRENT_DATE WHERE user_id = $1`,
    [userId]
  );
  console.log('Kill switch deactivated, daily PnL reset for test');

  const rawBody = '{}';
  const events = [];

  try {
    // ── 1. CRT BULL (direct JSON payload) ──
    console.log('\n── 1. CRT BULL (direct JSON) ──');
    const bullResult = await webhookService.ingest(CRT_BULL_PAYLOAD, rawBody, '', userId, {});
    console.log(`   Ingest: ${bullResult.isDuplicate ? 'duplicate' : 'stored'} status=${bullResult.event?.status}`);
    events.push({ name: 'CRT_BULL', event: bullResult.event });

    const bullProcess = await webhookProcessor.processEvent(bullResult.event);
    console.log(`   Process: approved=${bullProcess.approved} executed=${bullProcess.executed}`);
    if (bullProcess.reason) console.log(`   Reason: ${bullProcess.reason}`);
    if (bullProcess.executed) {
      console.log(`   Order: ${bullProcess.orderId} | Position: ${bullProcess.positionId} | Trade: ${bullProcess.tradeId || 'OPEN'}`);
    }

    // ── 2. CRT BEAR (direct JSON) ──
    console.log('\n── 2. CRT BEAR (direct JSON) ──');
    const bearResult = await webhookService.ingest(CRT_BEAR_PAYLOAD, rawBody, '', userId, {});
    console.log(`   Ingest: ${bearResult.isDuplicate ? 'duplicate' : 'stored'} status=${bearResult.event?.status}`);
    events.push({ name: 'CRT_BEAR', event: bearResult.event });

    const bearProcess = await webhookProcessor.processEvent(bearResult.event);
    console.log(`   Process: approved=${bearProcess.approved} executed=${bearProcess.executed}`);
    if (bearProcess.reason) console.log(`   Reason: ${bearProcess.reason}`);
    if (bearProcess.executed) {
      console.log(`   Order: ${bearProcess.orderId} | Position: ${bearProcess.positionId} | Trade: ${bearProcess.tradeId || 'OPEN'}`);
    }

    // ── 3. CRT via TradingView message format ──
    console.log('\n── 3. CRT BULL (TradingView message format) ──');
    const msgPayload = { ...CRT_BULL_PAYLOAD, signal_id: NONCE() };
    const wrapped = wrapCrtMessage(msgPayload, 'BULL');
    // Simulate controller parsing: extract JSON from message
    const jsonStr = wrapped.message.split('CRT BULL:')[1]?.trim();
    const parsedPayload = jsonStr ? JSON.parse(jsonStr) : msgPayload;
    const msgResult = await webhookService.ingest(parsedPayload, JSON.stringify(wrapped), '', userId, {});
    console.log(`   Ingest: ${msgResult.isDuplicate ? 'duplicate' : 'stored'}`);
    const msgProcess = await webhookProcessor.processEvent(msgResult.event);
    console.log(`   Process: approved=${msgProcess.approved} executed=${msgProcess.executed} ${msgProcess.reason || ''}`);

    // ── 4. Duplicate (same signal_id) should be deduped ──
    console.log('\n── 4. Duplicate CRT (same signal_id) ──');
    const dupResult = await webhookService.ingest(CRT_BULL_PAYLOAD, rawBody, '', userId, {});
    console.log(`   Ingest: ${dupResult.isDuplicate ? 'DUPLICATE (ignored) ✓' : 'stored'}`);

    // ── 5. Query results ──
    console.log('\n' + '='.repeat(70));
    console.log('RESULTS');
    console.log('='.repeat(70));

    const webhooks = await db.query(
      `SELECT id, indicator_source, status, error_message, received_at, processed_at
       FROM webhook_events
       WHERE user_id = $1 AND indicator_source = 'CRT'
       ORDER BY received_at DESC LIMIT 10`,
      [userId]
    );
    console.log('\nWebhook events (CRT):');
    console.table(webhooks.rows.map((r) => ({
      id: r.id?.slice(0, 8),
      source: r.indicator_source,
      status: r.status,
      error: (r.error_message || '').slice(0, 40),
      received: r.received_at?.toISOString().slice(11, 19),
    })));

    const orders = await db.query(
      `SELECT so.id, so.symbol, so.side, so.contract_type, so.intent_payload->>'strike' as strike,
              so.intent_payload->>'expiration' as expiration, so.status, so.rejection_reason, we.indicator_source
       FROM sim_orders so
       JOIN webhook_events we ON we.id = so.webhook_event_id
       WHERE so.user_id = $1 AND we.indicator_source = 'CRT'
       ORDER BY so.created_at DESC LIMIT 10`,
      [userId]
    );
    console.log('\nSim orders (from CRT):');
    if (orders.rows.length > 0) {
      console.table(orders.rows.map((r) => ({
        id: r.id?.slice(0, 8),
        symbol: r.symbol,
        side: r.side,
        type: r.contract_type,
        strike: r.strike,
        status: r.status,
        rejection: (r.rejection_reason || '').slice(0, 30),
      })));
    } else {
      console.log('  (none)');
    }

    const positions = await db.query(
      `SELECT sp.id, sp.underlying_symbol, sp.contract_type, sp.strike, sp.expiration,
              sp.quantity, sp.status, sp.stop_loss, sp.take_profit, we.indicator_source
       FROM sim_positions sp
       JOIN webhook_events we ON we.id = sp.webhook_event_id
       WHERE sp.user_id = $1 AND we.indicator_source = 'CRT'
       ORDER BY sp.opened_at DESC LIMIT 10`,
      [userId]
    );
    console.log('\nSim positions (from CRT):');
    if (positions.rows.length > 0) {
      console.table(positions.rows.map((r) => ({
        id: r.id?.slice(0, 8),
        symbol: r.underlying_symbol,
        type: r.contract_type,
        strike: r.strike,
        qty: r.quantity,
        status: r.status,
        stop: r.stop_loss,
        tp: r.take_profit,
      })));
    } else {
      console.log('  (none)');
    }

    const trades = await db.query(
      `SELECT st.id, st.symbol, st.contract_type, st.pnl, st.exit_reason, st.entry_time, st.exit_time
       FROM sim_trades st
       JOIN webhook_events we ON we.id = st.webhook_event_id
       WHERE st.user_id = $1 AND we.indicator_source = 'CRT'
       ORDER BY st.entry_time DESC LIMIT 10`,
      [userId]
    );
    console.log('\nSim trades (from CRT):');
    if (trades.rows.length > 0) {
      console.table(trades.rows.map((r) => ({
        id: r.id?.slice(0, 8),
        symbol: r.symbol,
        type: r.contract_type,
        pnl: r.pnl,
        exit_reason: r.exit_reason,
      })));
    } else {
      console.log('  (none — positions may still be OPEN; exit monitor will close on stop/TP)');
    }

    // Intelligence verdicts
    const verdicts = await db.query(
      `SELECT iv.symbol, iv.direction, iv.strategy, iv.intelligence_score, iv.allowed, iv.rejection_reason
       FROM intelligence_verdicts iv
       JOIN webhook_events we ON we.id = iv.webhook_event_id
       WHERE iv.user_id = $1 AND we.indicator_source = 'CRT'
       ORDER BY iv.created_at DESC LIMIT 5`,
      [userId]
    );
    console.log('\nIntelligence verdicts (CRT):');
    if (verdicts.rows.length > 0) {
      console.table(verdicts.rows);
    } else {
      console.log('  (none)');
    }

    console.log('\n' + '='.repeat(70));
    console.log('Exit monitor runs every ~15s. OPEN positions with stop_loss/take_profit');
    console.log('will be closed when underlying breaches those levels.');
    console.log('='.repeat(70) + '\n');
  } catch (err) {
    console.error('\nError:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
  process.exit(0);
}

run();
