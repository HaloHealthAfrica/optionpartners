#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('fly') || process.env.DATABASE_URL?.includes('sslmode')
    ? { rejectUnauthorized: false }
    : false,
});

async function q(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

function section(title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function fmt(obj) {
  return JSON.stringify(obj, null, 2);
}

async function run() {
  try {
    const now = new Date();
    console.log(`\nE2E PIPELINE DIAGNOSTIC — ${now.toISOString()}`);
    console.log(`Today (UTC): ${now.toISOString().slice(0, 10)}`);

    // ── STAGE 1: Are webhooks arriving? ──
    section('STAGE 1: WEBHOOK INGESTION');
    const whSummary = await q(`
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
    console.log('Webhook Summary:', fmt(whSummary[0]));

    if (whSummary[0].total === 0) {
      console.log('\n*** NO WEBHOOKS RECEIVED TODAY ***');
      console.log('Possible causes:');
      console.log('  - TradingView alerts not firing');
      console.log('  - Webhook URL misconfigured');
      console.log('  - App not running / not accessible');
      console.log('  - Market closed / no signals generated');
    }

    // Webhooks by source
    const whBySource = await q(`
      SELECT indicator_source, status, COUNT(*)::int AS cnt
      FROM webhook_events
      WHERE received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      GROUP BY indicator_source, status
      ORDER BY indicator_source, status
    `);
    console.log('\nWebhooks by Source & Status:');
    whBySource.forEach(r => console.log(`  ${r.indicator_source || 'NULL'} [${r.status}]: ${r.cnt}`));

    // Trade-trigger webhooks specifically
    const triggerWebhooks = await q(`
      SELECT indicator_source, status, COUNT(*)::int AS cnt
      FROM webhook_events
      WHERE received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
        AND indicator_source IN ('SIGNALS', 'STRAT', 'ORB', 'PIVOT_MB', 'SQUEEZE_PRO')
      GROUP BY indicator_source, status
      ORDER BY indicator_source
    `);
    console.log('\nTrade-Trigger Webhooks (SIGNALS/STRAT/ORB/PIVOT_MB/SQUEEZE_PRO):');
    if (triggerWebhooks.length === 0) {
      console.log('  *** NONE — no trade-triggering webhooks received today ***');
      console.log('  Only context-update sources (MTF_BIAS, TREND, etc.) arrived.');
      console.log('  These update symbol state but DO NOT trigger trades.');
    } else {
      triggerWebhooks.forEach(r => console.log(`  ${r.indicator_source} [${r.status}]: ${r.cnt}`));
    }

    // ── STAGE 2: Are webhooks stuck in RECEIVED? ──
    section('STAGE 2: WEBHOOK PROCESSOR STATUS');
    const stuckReceived = await q(`
      SELECT COUNT(*)::int AS stuck_count,
             MIN(received_at) AS oldest_stuck,
             MAX(received_at) AS newest_stuck
      FROM webhook_events
      WHERE status = 'RECEIVED'
        AND received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
    `);
    console.log('Stuck in RECEIVED:', fmt(stuckReceived[0]));
    if (parseInt(stuckReceived[0].stuck_count) > 0) {
      console.log('  *** Webhooks stuck in RECEIVED — processor may not be running ***');
    }

    // Last 20 webhooks with full detail
    const recentWh = await q(`
      SELECT id, indicator_source, status, error_message,
             received_at, processed_at,
             raw_payload->>'ticker' AS ticker,
             raw_payload->>'symbol' AS symbol,
             raw_payload->>'direction' AS direction,
             raw_payload->>'action' AS action,
             raw_payload->>'source' AS source,
             raw_payload->>'score' AS score,
             raw_payload->>'event' AS event,
             EXTRACT(EPOCH FROM (processed_at - received_at))::numeric(8,2) AS latency_sec
      FROM webhook_events
      WHERE received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY received_at DESC
      LIMIT 20
    `);
    console.log('\nLast 20 Webhooks:');
    recentWh.forEach((w, i) => {
      const sym = w.ticker || w.symbol || 'N/A';
      const dir = w.direction || w.action || '';
      console.log(`  ${i + 1}. [${w.status}] ${w.indicator_source || 'UNKNOWN'} — ${sym} ${dir} score=${w.score || 'N/A'} event=${w.event || 'N/A'}`);
      console.log(`     Received: ${w.received_at}  Processed: ${w.processed_at || 'PENDING'}  Latency: ${w.latency_sec || 'N/A'}s`);
      if (w.error_message) console.log(`     ERROR: ${w.error_message}`);
    });

    // ── STAGE 3: Signal Rejections (where approved signals get blocked) ──
    section('STAGE 3: SIGNAL REJECTIONS (Gate-Level Blocks)');
    const rejSummary = await q(`
      SELECT gate, rejection_reason, COUNT(*)::int AS cnt
      FROM signal_rejections
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      GROUP BY gate, rejection_reason
      ORDER BY cnt DESC
    `);
    console.log('Rejection Summary by Gate:');
    if (rejSummary.length === 0) {
      console.log('  No signal rejections today (signals never reached decision gates)');
    } else {
      rejSummary.forEach(r => console.log(`  ${r.gate} [${r.rejection_reason || 'N/A'}]: ${r.cnt} rejections`));
    }

    // Detailed rejections
    const rejDetails = await q(`
      SELECT symbol, strategy, action, gate, rejection_reason, reason, created_at
      FROM signal_rejections
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY created_at DESC
      LIMIT 30
    `);
    console.log('\nDetailed Rejections (last 30):');
    rejDetails.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.symbol} ${r.strategy} [${r.gate}/${r.rejection_reason || 'N/A'}] — ${r.reason?.substring(0, 120)}`);
    });

    // ── STAGE 4: Intelligence Verdicts ──
    section('STAGE 4: INTELLIGENCE VERDICTS');
    const verdictSummary = await q(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE allowed = true)::int AS allowed,
        COUNT(*) FILTER (WHERE allowed = false)::int AS blocked,
        AVG(intelligence_score)::numeric(6,2) AS avg_score
      FROM intelligence_verdicts
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
    `);
    console.log('Verdict Summary:', fmt(verdictSummary[0]));

    const verdictDetails = await q(`
      SELECT symbol, direction, strategy, intelligence_score,
             allowed, rejection_reason, created_at,
             checks_detail->>'action' AS engine_action
      FROM intelligence_verdicts
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY created_at DESC
      LIMIT 20
    `);
    console.log('\nVerdict Details (last 20):');
    verdictDetails.forEach((v, i) => {
      const status = v.allowed ? 'ALLOWED' : 'BLOCKED';
      console.log(`  ${i + 1}. [${status}] ${v.symbol} ${v.direction} ${v.strategy} score=${v.intelligence_score} action=${v.engine_action || 'N/A'}`);
      if (v.rejection_reason) console.log(`     Rejection: ${v.rejection_reason.substring(0, 120)}`);
    });

    // ── STAGE 5: Sim Orders ──
    section('STAGE 5: SIM ORDERS');
    const orderSummary = await q(`
      SELECT status, COUNT(*)::int AS cnt
      FROM sim_orders
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      GROUP BY status
    `);
    console.log('Order Summary:', fmt(orderSummary));

    const orderDetails = await q(`
      SELECT id, symbol, side, contract_type, strategy, indicator_source,
             status, rejection_reason, quantity, limit_price, created_at
      FROM sim_orders
      WHERE created_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY created_at DESC
      LIMIT 20
    `);
    console.log('\nOrder Details (last 20):');
    orderDetails.forEach((o, i) => {
      console.log(`  ${i + 1}. [${o.status}] ${o.side} ${o.symbol} ${o.contract_type} qty=${o.quantity} strategy=${o.strategy}`);
      if (o.rejection_reason) console.log(`     Rejection: ${o.rejection_reason}`);
    });

    // ── STAGE 6: Positions & Trades ──
    section('STAGE 6: POSITIONS & TRADES');
    const positions = await q(`
      SELECT id, symbol, underlying_symbol, contract_type, strike, expiration,
             quantity, avg_price, current_price, unrealized_pnl, strategy,
             status, opened_at, closed_at
      FROM sim_positions
      WHERE opened_at >= CURRENT_DATE AT TIME ZONE 'UTC'
         OR closed_at >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY opened_at DESC
      LIMIT 20
    `);
    console.log(`Positions today: ${positions.length}`);
    positions.forEach((p, i) => {
      console.log(`  ${i + 1}. [${p.status}] ${p.underlying_symbol} ${p.contract_type} ${p.strike} exp=${p.expiration} qty=${p.quantity} avg=$${p.avg_price}`);
    });

    const trades = await q(`
      SELECT id, symbol, underlying_symbol, strategy, entry_price, exit_price,
             pnl, exit_reason, entry_time, exit_time
      FROM sim_trades
      WHERE entry_time >= CURRENT_DATE AT TIME ZONE 'UTC'
         OR exit_time >= CURRENT_DATE AT TIME ZONE 'UTC'
      ORDER BY COALESCE(exit_time, entry_time) DESC
      LIMIT 20
    `);
    console.log(`\nTrades today: ${trades.length}`);
    trades.forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.underlying_symbol} ${t.strategy} entry=$${t.entry_price} exit=$${t.exit_price || 'N/A'} PnL=$${t.pnl || 'N/A'} reason=${t.exit_reason || 'N/A'}`);
    });

    // ── STAGE 7: Account State & Kill Switch ──
    section('STAGE 7: ACCOUNT STATE & KILL SWITCH');
    const acct = await q(`
      SELECT cash_balance, buying_power, equity, unrealized_pnl, realized_pnl,
             peak_equity, max_drawdown, daily_pnl, kill_switch_active, 
             daily_pnl_reset_at, updated_at
      FROM sim_account_state
      LIMIT 5
    `);
    console.log('Account State:');
    acct.forEach(a => {
      console.log(`  Cash: $${a.cash_balance} | Buying Power: $${a.buying_power} | Equity: $${a.equity}`);
      console.log(`  Daily PnL: $${a.daily_pnl || 0} | Kill Switch: ${a.kill_switch_active}`);
      console.log(`  Daily PnL Reset: ${a.daily_pnl_reset_at || 'never'} | Updated: ${a.updated_at}`);
    });

    // ── STAGE 8: Active Cooldowns ──
    section('STAGE 8: ACTIVE COOLDOWNS');
    const cooldowns = await q(`
      SELECT strategy, cooldown_until, reason, created_at
      FROM strategy_cooldowns
      WHERE cooldown_until > NOW()
      ORDER BY cooldown_until DESC
      LIMIT 10
    `);
    if (cooldowns.length === 0) {
      console.log('No active cooldowns');
    } else {
      cooldowns.forEach(c => console.log(`  ${c.strategy} until ${c.cooldown_until} — ${c.reason}`));
    }

    // ── STAGE 9: Open Positions (blocking new entries?) ──
    section('STAGE 9: CURRENT OPEN POSITIONS');
    const openPositions = await q(`
      SELECT id, symbol, underlying_symbol, contract_type, strike, expiration,
             quantity, avg_price, current_price, unrealized_pnl, strategy,
             opened_at, stop_loss, take_profit
      FROM sim_positions
      WHERE status = 'OPEN'
      ORDER BY opened_at DESC
    `);
    console.log(`Open positions: ${openPositions.length} (max allowed: ${process.env.SIM_MAX_OPEN_POSITIONS || 5})`);
    openPositions.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.underlying_symbol} ${p.contract_type} ${p.strike} exp=${p.expiration} qty=${p.quantity} avg=$${p.avg_price} PnL=$${p.unrealized_pnl || 'N/A'}`);
      console.log(`     Opened: ${p.opened_at} | SL: ${p.stop_loss || 'N/A'} | TP: ${p.take_profit || 'N/A'}`);
    });

    // ── STAGE 10: Strategy Scorecard ──
    section('STAGE 10: STRATEGY SCORECARD');
    const scorecard = await q(`
      SELECT strategy, total_trades, wins, losses, win_rate, profit_factor,
             avg_pnl, is_gated, gate_reason, updated_at
      FROM strategy_scorecard
      ORDER BY strategy
    `);
    if (scorecard.length === 0) {
      console.log('No strategy scorecard data');
    } else {
      scorecard.forEach(s => {
        const gated = s.is_gated ? ` [GATED: ${s.gate_reason}]` : '';
        console.log(`  ${s.strategy}: ${s.total_trades} trades, WR=${(s.win_rate * 100).toFixed(1)}%, PF=${s.profit_factor}${gated}`);
      });
    }

    // ── STAGE 11: Suppressed Strategies ──
    section('STAGE 11: STRATEGY SUPPRESSION CHECK');
    const suppressed = (process.env.SUPPRESSED_STRATEGIES || 'SIGNALS').split(',').map(s => s.trim());
    console.log(`SUPPRESSED_STRATEGIES env: [${suppressed.join(', ')}]`);
    console.log('Any webhook with these strategies will be blocked at STRATEGY_GATE.');

    // ── STAGE 12: Pipeline trace for trigger webhooks ──
    section('STAGE 12: END-TO-END PIPELINE TRACE (trigger webhooks only)');
    const triggerTrace = await q(`
      SELECT we.id, we.indicator_source, we.status AS wh_status,
             we.raw_payload->>'ticker' AS ticker,
             we.raw_payload->>'direction' AS direction,
             we.raw_payload->>'score' AS score,
             we.received_at, we.processed_at, we.error_message,
             sr.gate AS rejection_gate, sr.rejection_reason, sr.reason AS rejection_detail,
             iv.allowed AS verdict_allowed, iv.intelligence_score, iv.rejection_reason AS verdict_rejection,
             so.id AS order_id, so.status AS order_status, so.rejection_reason AS order_rejection,
             sp.id AS position_id, sp.status AS position_status,
             st.id AS trade_id, st.pnl
      FROM webhook_events we
      LEFT JOIN signal_rejections sr ON sr.webhook_event_id = we.id
      LEFT JOIN intelligence_verdicts iv ON iv.webhook_event_id = we.id
      LEFT JOIN sim_orders so ON so.webhook_event_id = we.id
      LEFT JOIN sim_positions sp ON sp.webhook_event_id = we.id
      LEFT JOIN sim_trades st ON st.webhook_event_id = we.id
      WHERE we.received_at >= CURRENT_DATE AT TIME ZONE 'UTC'
        AND we.indicator_source IN ('SIGNALS', 'STRAT', 'ORB', 'PIVOT_MB', 'SQUEEZE_PRO')
      ORDER BY we.received_at DESC
      LIMIT 30
    `);
    if (triggerTrace.length === 0) {
      console.log('  *** NO TRADE-TRIGGER WEBHOOKS TODAY ***');
      console.log('  The system only received context-update webhooks (MTF_BIAS, TREND, etc.)');
      console.log('  These enrich symbol state but never trigger trade evaluation.');
    } else {
      triggerTrace.forEach((t, i) => {
        console.log(`\n  --- Webhook ${i + 1} (ID: ${t.id}) ---`);
        console.log(`  Source: ${t.indicator_source} | Ticker: ${t.ticker} | Direction: ${t.direction} | Score: ${t.score}`);
        console.log(`  WH Status: ${t.wh_status} | Received: ${t.received_at} | Processed: ${t.processed_at || 'N/A'}`);
        if (t.error_message) console.log(`  WH Error: ${t.error_message}`);
        if (t.rejection_gate) console.log(`  REJECTED at gate: ${t.rejection_gate} [${t.rejection_reason}] — ${t.rejection_detail?.substring(0, 120)}`);
        if (t.verdict_allowed !== null) console.log(`  Verdict: ${t.verdict_allowed ? 'ALLOWED' : 'BLOCKED'} score=${t.intelligence_score} ${t.verdict_rejection || ''}`);
        if (t.order_id) console.log(`  Order: ${t.order_id} status=${t.order_status} ${t.order_rejection || ''}`);
        if (t.position_id) console.log(`  Position: ${t.position_id} status=${t.position_status}`);
        if (t.trade_id) console.log(`  Trade: ${t.trade_id} PnL=$${t.pnl}`);
        if (!t.rejection_gate && !t.order_id && t.wh_status === 'PROCESSED') {
          console.log(`  ⚠ PROCESSED but no order/rejection — may have been context-only (STRAT without levels?)`);
        }
      });
    }

    // ── STAGE 13: Yesterday comparison ──
    section('STAGE 13: YESTERDAY COMPARISON');
    const yesterday = await q(`
      SELECT 
        COUNT(*)::int AS total_webhooks,
        COUNT(*) FILTER (WHERE indicator_source IN ('SIGNALS', 'STRAT', 'ORB', 'PIVOT_MB', 'SQUEEZE_PRO'))::int AS trigger_webhooks,
        COUNT(*) FILTER (WHERE status = 'PROCESSED')::int AS processed
      FROM webhook_events
      WHERE received_at >= (CURRENT_DATE - INTERVAL '1 day') AT TIME ZONE 'UTC'
        AND received_at < CURRENT_DATE AT TIME ZONE 'UTC'
    `);
    const yesterdayTrades = await q(`
      SELECT COUNT(*)::int AS total
      FROM sim_trades
      WHERE entry_time >= (CURRENT_DATE - INTERVAL '1 day') AT TIME ZONE 'UTC'
        AND entry_time < CURRENT_DATE AT TIME ZONE 'UTC'
    `);
    console.log('Yesterday:');
    console.log(`  Webhooks: ${yesterday[0].total_webhooks} (${yesterday[0].trigger_webhooks} triggers)`);
    console.log(`  Trades: ${yesterdayTrades[0].total}`);

    // ── DIAGNOSIS ──
    section('DIAGNOSIS');
    const diag = [];

    if (whSummary[0].total === 0) {
      diag.push('CRITICAL: No webhooks received today. TradingView alerts may not be firing or webhook URL is unreachable.');
    }
    if (whSummary[0].total > 0 && triggerWebhooks.length === 0) {
      diag.push('ROOT CAUSE: Webhooks are arriving but NONE are trade-trigger sources (SIGNALS/STRAT/ORB/PIVOT_MB/SQUEEZE_PRO). Only context-update webhooks arrived. The system needs at least one trade-trigger webhook to evaluate a trade.');
    }
    if (parseInt(stuckReceived[0].stuck_count) > 5) {
      diag.push(`WARNING: ${stuckReceived[0].stuck_count} webhooks stuck in RECEIVED status — webhook processor may be down or crashed.`);
    }
    if (acct.length > 0 && acct[0].kill_switch_active) {
      diag.push('CRITICAL: Kill switch is ACTIVE — all trades are blocked.');
    }
    if (openPositions.length >= parseInt(process.env.SIM_MAX_OPEN_POSITIONS || '5')) {
      diag.push(`WARNING: Max open positions reached (${openPositions.length}/${process.env.SIM_MAX_OPEN_POSITIONS || 5}) — new entries blocked.`);
    }
    const suppRej = rejSummary.filter(r => r.rejection_reason === 'strategy_suppressed');
    if (suppRej.length > 0) {
      const totalSuppressed = suppRej.reduce((sum, r) => sum + r.cnt, 0);
      diag.push(`WARNING: ${totalSuppressed} signals blocked by SUPPRESSED_STRATEGIES=[${suppressed.join(',')}].`);
    }
    const emRej = rejSummary.filter(r => r.rejection_reason === 'expected_move');
    if (emRej.length > 0) {
      const totalEm = emRej.reduce((sum, r) => sum + r.cnt, 0);
      diag.push(`WARNING: ${totalEm} signals blocked by EXPECTED_MOVE filter (volatility too low for option premium).`);
    }
    const constructionRej = rejSummary.filter(r => r.rejection_reason === 'construction_failed');
    if (constructionRej.length > 0) {
      const totalCf = constructionRej.reduce((sum, r) => sum + r.cnt, 0);
      diag.push(`WARNING: ${totalCf} signals blocked by OPTIONS_CONSTRUCTOR (no suitable contract found).`);
    }

    if (diag.length === 0) {
      diag.push('No obvious issues detected. Check if TradingView alerts are configured for trade-trigger indicators.');
    }
    diag.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));

    console.log('\n' + '='.repeat(70));
    console.log('  DIAGNOSTIC COMPLETE');
    console.log('='.repeat(70) + '\n');

  } catch (err) {
    console.error('DIAGNOSTIC ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
