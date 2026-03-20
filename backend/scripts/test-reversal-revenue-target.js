#!/usr/bin/env node
'use strict';

// Allow test to proceed without chain data (data-service may be down)
process.env.SIM_REQUIRE_CHAIN_DATA = 'false';

/**
 * Test Reversal strategy trades through the revenue target service.
 * 1. Store STRAT_SETUP for STRAT_TRIGGER matching
 * 2. Ingest Reversal webhooks (EME, SPE, STRAT_TRIGGER)
 * 3. Process each through the webhook processor
 * 4. Query revenue_target_decisions and sim_trades for Reversal results
 */

const db = require('../src/config/database');
const { v4: uuidv4 } = require('uuid');
const webhookService = require('../src/modules/webhooks/webhook.service');
const webhookProcessor = require('../src/modules/sim/webhook-processor');
const reversalStratSetup = require('../src/modules/sim/reversal-strat-setup.service');

const TS = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17);

const PAYLOADS = {
  STRAT_SETUP: {
    signal: 'STRAT_SETUP',
    setup_id: `TEST-REV-${Date.now()}`,
    symbol: 'SPY',
    pattern: '212_FORMING_BULL',
    timeframe: '5',
    trigger_level: 450.50,
    setup_low: 448.20,
    expects_trigger: true,
    timestamp: TS(),
  },
  EME_CALL_ZONE: {
    symbol: 'SPY',
    timestamp: TS(),
    price: 450.25,
    expected_move: 2.15,
    signal_type: 'EM_CALL_ZONE',
    confidence: 72,
  },
  SPE_CALL_FAVORABLE: {
    symbol: 'SPY',
    timestamp: TS(),
    price: 450.25,
    signal: 'CALL_SPREAD_FAVORABLE',
    probability_score: 72.5,
    atr: 2.15,
    trend_state: 'BULLISH',
  },
  STRAT_TRIGGER: null, // Built dynamically with setup_id from STRAT_SETUP
};

async function run() {
  console.log('\n=== Reversal + Revenue Target Integration Test ===\n');

  let userId;
  try {
    const r = await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
    userId = r.rows[0]?.id;
    if (!userId) {
      console.error('No users in DB. Create a user first.');
      process.exit(1);
    }
    console.log(`Using user: ${userId}`);
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

  // Refresh symbol_state for SPY so trend/macro staleness checks pass
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
  console.log('Refreshed symbol_state for SPY');

  // Ensure revenue target config exists — disable for test so Reversal trades can execute
  await db.query(
    `INSERT INTO revenue_target_config (user_id, daily_target, max_trades_per_day, enabled)
     VALUES ($1, 250, 10, false)
     ON CONFLICT (user_id) DO UPDATE SET enabled = false`,
    [userId]
  );
  console.log('Revenue target disabled for test (enabled=false)');

  const setupId = PAYLOADS.STRAT_SETUP.setup_id;
  PAYLOADS.STRAT_TRIGGER = {
    signal: 'STRAT_TRIGGER',
    setup_id: setupId,
    symbol: 'SPY',
    pattern: '212_BULL',
    timeframe: '5',
    confidence_score: 78,
    timestamp: TS(),
  };

  const events = [];
  const rawBody = '{}';

  try {
    // 1. Ingest STRAT_SETUP (context-only, no trade)
    console.log('\n1. Ingesting STRAT_SETUP...');
    const setupResult = await webhookService.ingest(
      PAYLOADS.STRAT_SETUP, rawBody, '', userId, {}
    );
    if (setupResult.isDuplicate) {
      console.log('   (duplicate, using existing)');
    }
    const setupEvent = setupResult.event;
    events.push({ name: 'STRAT_SETUP', event: setupEvent });

    // 2. Process STRAT_SETUP - should store and return contextUpdateOnly
    console.log('   Processing STRAT_SETUP...');
    const setupProcess = await webhookProcessor.processEvent(setupEvent);
    console.log(`   Result: ${setupProcess.contextUpdate ? 'context-only ✓' : JSON.stringify(setupProcess)}`);

    // 3. Ingest EME_CALL_ZONE
    console.log('\n2. Ingesting EME_CALL_ZONE...');
    const emeResult = await webhookService.ingest(
      PAYLOADS.EME_CALL_ZONE, rawBody, '', userId, {}
    );
    events.push({ name: 'EME_CALL_ZONE', event: emeResult.event });

    // 4. Process EME_CALL_ZONE
    console.log('   Processing EME_CALL_ZONE...');
    const emeProcess = await webhookProcessor.processEvent(emeResult.event);
    console.log(`   Result: approved=${emeProcess.approved} executed=${emeProcess.executed} ${emeProcess.reason || ''}`);

    // 5. Ingest SPE_CALL_FAVORABLE
    console.log('\n3. Ingesting SPE_CALL_FAVORABLE...');
    PAYLOADS.SPE_CALL_FAVORABLE.timestamp = TS(); // fresh ts for dedup
    const speResult = await webhookService.ingest(
      PAYLOADS.SPE_CALL_FAVORABLE, rawBody, '', userId, {}
    );
    events.push({ name: 'SPE_CALL_FAVORABLE', event: speResult.event });

    // 6. Process SPE_CALL_FAVORABLE
    console.log('   Processing SPE_CALL_FAVORABLE...');
    const speProcess = await webhookProcessor.processEvent(speResult.event);
    console.log(`   Result: approved=${speProcess.approved} executed=${speProcess.executed} ${speProcess.reason || ''}`);

    // 7. Ingest STRAT_TRIGGER
    console.log('\n4. Ingesting STRAT_TRIGGER...');
    const stratResult = await webhookService.ingest(
      PAYLOADS.STRAT_TRIGGER, rawBody, '', userId, {}
    );
    events.push({ name: 'STRAT_TRIGGER', event: stratResult.event });

    // 8. Process STRAT_TRIGGER
    console.log('   Processing STRAT_TRIGGER...');
    const stratProcess = await webhookProcessor.processEvent(stratResult.event);
    console.log(`   Result: approved=${stratProcess.approved} executed=${stratProcess.executed} ${stratProcess.reason || ''}`);

    // 9. Query revenue_target_decisions for Reversal
    console.log('\n=== Revenue Target Decisions (Reversal) ===\n');
    const decisions = await db.query(
      `SELECT rtd.id, rtd.created_at, rtd.symbol, rtd.action, rtd.instrument_desc,
              rtd.decision, rtd.reason, rtd.size_multiplier, rtd.trade_type, rtd.webhook_event_id,
              we.indicator_source, we.raw_payload->>'signal_type' as signal_type,
              we.raw_payload->>'signal' as signal
       FROM revenue_target_decisions rtd
       LEFT JOIN webhook_events we ON we.id = rtd.webhook_event_id
       WHERE rtd.user_id = $1 AND (we.indicator_source = 'REVERSAL' OR we.indicator_source IS NULL)
       ORDER BY rtd.created_at DESC
       LIMIT 20`,
      [userId]
    );

    if (decisions.rows.length === 0) {
      const allDecisions = await db.query(
        `SELECT rtd.id, rtd.created_at, rtd.symbol, rtd.action, rtd.decision, rtd.reason,
                we.indicator_source
         FROM revenue_target_decisions rtd
         LEFT JOIN webhook_events we ON we.id = rtd.webhook_event_id
         WHERE rtd.user_id = $1
         ORDER BY rtd.created_at DESC
         LIMIT 10`,
        [userId]
      );
      console.log('Recent revenue_target_decisions (all):');
      allDecisions.rows.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.created_at} ${r.symbol} ${r.action} ${r.decision} (${r.indicator_source || 'N/A'})`);
      });
    } else {
      decisions.rows.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.created_at} ${r.symbol} ${r.action} ${r.decision} ${r.trade_type || ''}`);
        console.log(`      reason: ${r.reason} | source: ${r.indicator_source} ${r.signal_type || r.signal || ''}`);
      });
    }

    // 10. Query sim_positions (open) and sim_trades (closed) for Reversal
    console.log('\n=== Sim Positions (Reversal - open) ===\n');
    const positions = await db.query(
      `SELECT sp.id, sp.underlying_symbol, sp.contract_type, sp.strike, sp.quantity, sp.avg_price,
              sp.opened_at, we.indicator_source, we.raw_payload->>'signal_type' as signal_type,
              we.raw_payload->>'signal' as signal
       FROM sim_positions sp
       JOIN webhook_events we ON we.id = sp.webhook_event_id
       WHERE sp.user_id = $1 AND sp.status = 'OPEN' AND we.indicator_source = 'REVERSAL'
       ORDER BY sp.opened_at DESC
       LIMIT 10`,
      [userId]
    );
    if (positions.rows.length === 0) {
      console.log('No open Reversal positions');
    } else {
      positions.rows.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.underlying_symbol} ${r.contract_type} strike=${r.strike} qty=${r.quantity} @ $${r.avg_price} (${r.signal_type || r.signal || 'REVERSAL'})`);
      });
    }

    console.log('\n=== Sim Trades (Reversal - closed) ===\n');
    const trades = await db.query(
      `SELECT st.id, st.symbol, st.contract_type, st.strike, st.entry_price, st.pnl,
              st.strategy, we.indicator_source
       FROM sim_trades st
       JOIN webhook_events we ON we.id = st.webhook_event_id
       WHERE st.user_id = $1 AND we.indicator_source = 'REVERSAL'
       ORDER BY st.entry_time DESC
       LIMIT 10`,
      [userId]
    );
    if (trades.rows.length === 0) {
      console.log('No closed Reversal sim_trades yet');
    } else {
      trades.rows.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.symbol} ${r.contract_type} strike=${r.strike} $${r.entry_price} pnl=${r.pnl} strategy=${r.strategy}`);
      });
    }

    // 11. Intelligence verdicts for Reversal
    console.log('\n=== Intelligence Verdicts (Reversal) ===\n');
    const verdicts = await db.query(
      `SELECT iv.id, iv.symbol, iv.strategy, iv.direction, iv.allowed, iv.rejection_reason,
              we.indicator_source
       FROM intelligence_verdicts iv
       JOIN webhook_events we ON we.id = iv.webhook_event_id
       WHERE iv.user_id = $1 AND we.indicator_source = 'REVERSAL'
       ORDER BY iv.created_at DESC
       LIMIT 10`,
      [userId]
    );
    verdicts.rows.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.symbol} ${r.strategy} ${r.direction} allowed=${r.allowed} ${r.rejection_reason || ''}`);
    });

    console.log('\n=== Done ===\n');
  } catch (e) {
    console.error('Error:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
  process.exit(0);
}

run();
