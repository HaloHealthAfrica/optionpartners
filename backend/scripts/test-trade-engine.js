#!/usr/bin/env node
'use strict';

/**
 * End-to-end test: walks realistic webhook payloads through the full pipeline.
 *
 * Scenario A: SPY LONG — bullish alignment, all conditions met
 * Scenario B: Same SIGNALS webhook but hostile state (macro bearish, flow opposing, high IV)
 *
 * Runs the actual modules (symbol-state, trade-decision-engine) in-process,
 * no HTTP server or database required.
 */

// ── Stub the DB so modules load without a real connection ──
const dbStub = {
  query: async () => ({ rows: [] }),
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  pool: { end: () => {} },
};
require.cache[require.resolve('../src/config/database')] = { exports: dbStub };

// Stub logger to capture output
const logs = [];
const loggerStub = {
  info: (msg, ctx) => logs.push(`[INFO][${ctx}] ${msg}`),
  warn: (msg, ctx) => logs.push(`[WARN][${ctx}] ${msg}`),
  error: (msg, ctx) => logs.push(`[ERROR][${ctx}] ${msg}`),
};
require.cache[require.resolve('../src/utils/logger')] = { exports: loggerStub };

// Stub tradingMode
require.cache[require.resolve('../src/config/tradingMode')] = {
  exports: { assertSimMode: () => {} },
};

const { SymbolStateService } = require('../src/modules/sim/symbol-state.service');
const { TradeDecisionEngine } = require('../src/modules/sim/trade-decision-engine');

const stateService = new SymbolStateService();
// Override persist to no-op (no DB)
stateService._persist = async () => {};

const engine = new TradeDecisionEngine();

const USER = 'test-user';
const SEP = '═'.repeat(72);
const LINE = '─'.repeat(72);

function printState(state) {
  const fields = {
    'Macro Bias': `${state.macro_bias} (strength: ${state.macro_strength})`,
    'Regime': state.regime || '(none)',
    'Volatility': state.volatility_state || '(none)',
    'Room to Resistance': state.room_to_resistance || '(none)',
    'Room to Support': state.room_to_support || '(none)',
    'Local Bias': `${state.local_bias} (alignment: ${state.alignment_score}, conflict: ${state.conflict_score})`,
    'Last Price': state.last_price,
    'ATR': state.atr,
    'IV Percentile': state.iv_percentile,
    'Chain OK': state.chain_ok,
    'Liquidity OK': state.liquidity_ok,
    'Entry Signal': state.latest_entry_signal ? `${state.latest_entry_signal.direction} conf=${state.latest_entry_signal.confidence}` : '(none)',
    'STRAT Signal': state.latest_strat_signal ? `${state.latest_strat_signal.direction}` : '(none)',
    'Flow Signal': state.latest_flow_signal ? `${state.latest_flow_signal.direction} unusual=${state.latest_flow_signal.unusual}` : '(none)',
    'ORB Signal': state.latest_orb_signal ? `${state.latest_orb_signal.direction}` : '(none)',
  };

  for (const [k, v] of Object.entries(fields)) {
    console.log(`    ${k.padEnd(22)} ${v}`);
  }
}

function printDecision(d) {
  console.log(`    ACTION:           ${d.action}`);
  console.log(`    Ticker:           ${d.ticker}`);
  console.log(`    Conviction:       ${d.conviction_score}`);
  console.log(`    Size Multiplier:  ${d.size_multiplier}x`);
  console.log(`    Delta Target:     ${d.delta_target} (${d.delta_min}-${d.delta_max})`);
  console.log(`    DTE Target:       ${d.dte_target} (${d.dte_min}-${d.dte_max})`);
  console.log(`    Contract Type:    ${d.contractType || '(none)'}`);
  console.log(`    Stop Level:       ${d.risk_parameters.stop_level}`);
  console.log(`    Max Loss:         ${d.risk_parameters.max_loss}`);
  console.log('');
  console.log('    RATIONALE:');
  for (const r of d.rationale) {
    console.log(`      - ${r}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  WEBHOOK PAYLOADS
// ═══════════════════════════════════════════════════════════════════

const WEBHOOKS = {
  mtfBias_bullish: {
    source: 'MTF_BIAS_ENGINE_V3',
    event_type: 'BIAS_CHANGE',
    event_id_raw: 'MTF_BIAS_ENGINE_V3|SPY|5|1741276800000|BIAS_CHANGE',
    symbol: 'SPY',
    chart_tf: '5',
    bar: { time_ms: 1741276800000, open: 584.50, high: 585.80, low: 584.10, close: 585.20, volume: 1250000 },
    mtf: {
      consensus: { weighted_score: 78, bias: 'BULLISH', confidence: 0.82, alignment: 87.5, conflict: 12.5 },
      regime: { type: 'TREND', chop_score: 22, adx: 32, atr_state: 'EXPANDING' },
    },
    macro: { state: { macro_bias_score: 78, macro_confidence: 0.8, macro_class: 'MACRO_TREND_UP', macro_support: 570.00, macro_resistance: 595.00, macro_measured_move_target: 25.0 } },
    space: { dist_res_atr: 2.5, dist_sup_atr: 1.3, bucket: 'WIDE' },
    strat: { bar_type: '2U', combo: '1-2U', pattern: '2-1-2_CONT_UP', direction: 'BULLISH', triggered: true },
    risk_context: { invalidation_level: 578.00, invalidation_method: 'ORB', entry_mode_hint: 'BREAKOUT' },
    levels: { vwap: { value: 583.50, position: 'ABOVE', distance_atr: 0.4 }, orb: { high: 585.50, low: 583.80, mid: 584.65, state: 'ABOVE', age_min: 45 }, swings: { last_pivot_high: 587.20, last_pivot_low: 581.50 } },
    liquidity: { sweep_high: false, sweep_low: false, sweep_high_reject: false, sweep_low_reject: false, breakout_high: false, breakout_low: false, eq_high_cluster: false, eq_low_cluster: true },
    intent: { type: 'BREAKOUT', confidence: 0.8, regime_transition: false, trend_phase: 'MID' },
  },

  mtfBias_bearish: {
    source: 'MTF_BIAS_ENGINE_V3',
    event_type: 'BIAS_CHANGE',
    event_id_raw: 'MTF_BIAS_ENGINE_V3|SPY|5|1741276800001|BIAS_CHANGE',
    symbol: 'SPY',
    chart_tf: '5',
    bar: { time_ms: 1741276800001, open: 586.00, high: 586.50, low: 584.80, close: 585.20, volume: 1100000 },
    mtf: {
      consensus: { weighted_score: 70, bias: 'BEARISH', confidence: 0.75, alignment: 75.0, conflict: 25.0 },
      regime: { type: 'CHOP', chop_score: 68, adx: 18, atr_state: 'CONTRACTING' },
    },
    macro: { state: { macro_bias_score: 70, macro_confidence: 0.7, macro_class: 'MACRO_TREND_DOWN', macro_support: 575.00, macro_resistance: 590.00, macro_measured_move_target: 15.0 } },
    space: { dist_res_atr: 0.8, dist_sup_atr: 2.6, bucket: 'NARROW_UP' },
    strat: { bar_type: '2D', combo: '1-2D', pattern: '2-1-2_CONT_DOWN', direction: 'BEARISH', triggered: true },
    risk_context: { invalidation_level: 590.00, invalidation_method: 'SWING', entry_mode_hint: 'BREAKOUT' },
    levels: { vwap: { value: 587.00, position: 'BELOW', distance_atr: 0.5 }, orb: { high: 587.50, low: 584.20, mid: 585.85, state: 'INSIDE', age_min: 30 }, swings: { last_pivot_high: 589.20, last_pivot_low: 583.50 } },
    liquidity: { sweep_high: false, sweep_low: false, sweep_high_reject: false, sweep_low_reject: false, breakout_high: false, breakout_low: false, eq_high_cluster: true, eq_low_cluster: false },
    intent: { type: 'BREAKDOWN', confidence: 0.7, regime_transition: false, trend_phase: 'LATE' },
  },

  trendDots_bullish: {
    ticker: 'SPY',
    bias: 'bullish',
    alignment_score: 82,
    timeframes: {
      '5m': { dir: 'bullish', chg: false },
      '15m': { dir: 'bullish', chg: true },
      '1h': { dir: 'bullish', chg: false },
      '4h': { dir: 'bullish', chg: false },
      '1w': { dir: 'bearish', chg: false },
    },
  },

  trendDots_mixed: {
    ticker: 'SPY',
    bias: 'bearish',
    alignment_score: 55,
    conflict_score: 45,
    timeframes: {
      '5m': { dir: 'bearish', chg: true },
      '15m': { dir: 'bearish', chg: false },
      '1h': { dir: 'bullish', chg: false },
      '4h': { dir: 'bullish', chg: false },
      '1w': { dir: 'bearish', chg: false },
    },
  },

  strat_bullish: {
    ticker: 'SPY',
    journal: { engine: 'STRAT_V6_FULL' },
    signal: { side: 'LONG' },
    trend: 'bullish',
    setup: '2-1-2U',
    score: 8,
    entry: 585.30,
    stop: 582.00,
    target: 590.00,
  },

  strat_bearish: {
    ticker: 'SPY',
    journal: { engine: 'STRAT_V6_FULL' },
    signal: { side: 'SHORT' },
    trend: 'bearish',
    setup: '2-1-2D',
    score: 7,
    entry: 585.00,
    stop: 588.00,
    target: 580.00,
  },

  flow_bullish: {
    event_type: 'OPTIONS_FLOW',
    symbol: 'SPY',
    type: 'call',
    strike: 590,
    expiry: '2026-03-13',
    premium: 125000,
    size: 500,
    sentiment: 'bullish',
    unusual: true,
    size_percentile: 92,
  },

  flow_bearish: {
    event_type: 'OPTIONS_FLOW',
    symbol: 'SPY',
    type: 'put',
    strike: 575,
    expiry: '2026-03-13',
    premium: 200000,
    size: 800,
    sentiment: 'bearish',
    unusual: true,
    size_percentile: 95,
  },

  priceTick: {
    symbol: 'SPY',
    price: 585.20,
    volume: 45000000,
    high: 587.50,
    low: 583.10,
    open: 584.00,
    atr: 3.80,
  },

  chainSnapshot: {
    symbol: 'SPY',
    iv_percentile: 45,
    contracts: [
      { type: 'call', strike: 585, expiration: '2026-03-13', bid: 4.20, ask: 4.50, mid: 4.35, delta: 0.52, openInterest: 15000, volume: 3200, impliedVolatility: 0.18 },
      { type: 'call', strike: 590, expiration: '2026-03-13', bid: 2.10, ask: 2.35, mid: 2.225, delta: 0.38, openInterest: 22000, volume: 5100, impliedVolatility: 0.19 },
      { type: 'put', strike: 580, expiration: '2026-03-13', bid: 3.00, ask: 3.30, mid: 3.15, delta: -0.42, openInterest: 18000, volume: 4200, impliedVolatility: 0.17 },
    ],
  },

  chainSnapshot_highIV: {
    symbol: 'SPY',
    iv_percentile: 85,
    contracts: [
      { type: 'call', strike: 585, expiration: '2026-03-13', bid: 6.20, ask: 6.80, mid: 6.50, delta: 0.55, openInterest: 12000, volume: 2800, impliedVolatility: 0.32 },
      { type: 'put', strike: 580, expiration: '2026-03-13', bid: 5.50, ask: 6.10, mid: 5.80, delta: -0.48, openInterest: 14000, volume: 3100, impliedVolatility: 0.33 },
    ],
  },

  signals_spy_long: {
    ticker: 'SPY',
    signal: { type: 'LONG', quality: 'A', ai_score: 82, bar_time: '2026-02-26T15:30:00Z' },
    trend: 'bullish',
    trend_data: { alignment: 'bullish', atr: 3.80 },
    score: 78,
    score_breakdown: { total: 78, trend: 20, momentum: 18, volume: 15, pattern: 25 },
    confidence: 75,
    direction: 'LONG',
    pattern: 'MOMENTUM_BREAKOUT',
    setup: 'MOMENTUM_BREAKOUT',
    entry: { price: 585.20, stop_loss: 581.40, target_1: 589.00, target_2: 593.00 },
    risk: { rr_ratio: 2.3, stop_loss: 581.40, max_loss: 380, target_1: 589.00, target_2: 593.00 },
    current_price: 585.20,
    market_session: 'REGULAR',
    market_context: { session: 'REGULAR', volume_vs_avg: 1.5, atr: 3.80 },
    timeframe: '15',
    timestamp: Math.floor(Date.now() / 1000),
  },
};

// ═══════════════════════════════════════════════════════════════════
//  SCENARIO A: BULLISH ALIGNMENT
// ═══════════════════════════════════════════════════════════════════

async function scenarioA() {
  console.log(SEP);
  console.log('  SCENARIO A: SPY LONG — Full bullish alignment');
  console.log(SEP);

  const steps = [
    { label: '1. MTF_BIAS (BULLISH, TREND regime)',     src: 'MTF_BIAS',      payload: WEBHOOKS.mtfBias_bullish },
    { label: '2. TREND Dots (82% alignment, bullish)',  src: 'TREND',         payload: WEBHOOKS.trendDots_bullish },
    { label: '3. STRAT (2-1-2U bullish confirmation)',  src: 'STRAT',         payload: WEBHOOKS.strat_bullish },
    { label: '4. OPTIONS FLOW (unusual bullish calls)',  src: 'OPTIONS_FLOW',  payload: WEBHOOKS.flow_bullish },
    { label: '5. PRICE TICK (SPY @ 585.20)',            src: 'PRICE_TICK',    payload: WEBHOOKS.priceTick },
    { label: '6. CHAIN SNAPSHOT (IV 45%, liquid)',       src: 'CHAIN_SNAPSHOT',payload: WEBHOOKS.chainSnapshot },
  ];

  // Feed context webhooks into state
  for (const step of steps) {
    console.log(`\n${LINE}`);
    console.log(`  WEBHOOK: ${step.label}`);
    console.log(`  Source: ${step.src} (context update — no trade triggered)`);
    await stateService.update(step.src, step.payload, USER, 'SPY');
  }

  console.log(`\n${LINE}`);
  console.log('  STATE AFTER CONTEXT WEBHOOKS:');
  const state = await stateService.getState(USER, 'SPY');
  printState(state);

  // Now feed the SIGNALS webhook — this triggers trade evaluation
  console.log(`\n${SEP}`);
  console.log('  WEBHOOK 7: SIGNALS (SPY LONG) — TRADE TRIGGER');
  console.log(SEP);

  await stateService.update('SIGNALS', WEBHOOKS.signals_spy_long, USER, 'SPY');
  const finalState = await stateService.getState(USER, 'SPY');

  console.log('\n  UPDATED STATE:');
  printState(finalState);

  // Build a mock signal matching what decision-router would produce
  const mockSignal = {
    symbol: 'SPY',
    action: 'BUY',
    direction: 'long',
    confidence: 75,
    indicatorSource: 'SIGNALS',
    strategy: 'MOMENTUM_BREAKOUT',
    score: 78,
    quantity: 1,
  };

  const mockAccount = { daily_pnl: 150, kill_switch_active: false };
  logs.length = 0;

  console.log('\n  RUNNING TRADE DECISION ENGINE...\n');
  const decision = await engine.evaluate(mockSignal, finalState, mockAccount, USER);

  console.log('  TRADE DECISION:');
  console.log(LINE);
  printDecision(decision);
  console.log(LINE);

  if (logs.length > 0) {
    console.log('\n  ENGINE LOGS:');
    for (const l of logs) console.log(`    ${l}`);
  }

  return decision;
}

// ═══════════════════════════════════════════════════════════════════
//  SCENARIO B: HOSTILE CONDITIONS
// ═══════════════════════════════════════════════════════════════════

async function scenarioB() {
  console.log(`\n\n${SEP}`);
  console.log('  SCENARIO B: SPY LONG — Hostile conditions');
  console.log('  (macro BEARISH, flow opposing, IV 85%, CHOP regime)');
  console.log(SEP);

  // Fresh state service for scenario B
  const stateB = new SymbolStateService();
  stateB._persist = async () => {};

  const steps = [
    { label: '1. MTF_BIAS (BEARISH, CHOP regime)',      src: 'MTF_BIAS',      payload: WEBHOOKS.mtfBias_bearish },
    { label: '2. TREND Dots (55% alignment, mixed)',    src: 'TREND',         payload: WEBHOOKS.trendDots_mixed },
    { label: '3. STRAT (2-1-2D bearish)',               src: 'STRAT',         payload: WEBHOOKS.strat_bearish },
    { label: '4. OPTIONS FLOW (unusual bearish puts)',   src: 'OPTIONS_FLOW',  payload: WEBHOOKS.flow_bearish },
    { label: '5. PRICE TICK (SPY @ 585.20)',            src: 'PRICE_TICK',    payload: WEBHOOKS.priceTick },
    { label: '6. CHAIN SNAPSHOT (IV 85%, liquid)',       src: 'CHAIN_SNAPSHOT',payload: WEBHOOKS.chainSnapshot_highIV },
  ];

  for (const step of steps) {
    console.log(`\n${LINE}`);
    console.log(`  WEBHOOK: ${step.label}`);
    console.log(`  Source: ${step.src} (context update)`);
    await stateB.update(step.src, step.payload, USER, 'SPY');
  }

  console.log(`\n${LINE}`);
  console.log('  STATE AFTER CONTEXT WEBHOOKS:');
  const state = await stateB.getState(USER, 'SPY');
  printState(state);

  // Same SIGNALS webhook
  console.log(`\n${SEP}`);
  console.log('  WEBHOOK 7: SAME SIGNALS (SPY LONG) — TRADE TRIGGER');
  console.log(SEP);

  await stateB.update('SIGNALS', WEBHOOKS.signals_spy_long, USER, 'SPY');
  const finalState = await stateB.getState(USER, 'SPY');

  console.log('\n  UPDATED STATE:');
  printState(finalState);

  const mockSignal = {
    symbol: 'SPY',
    action: 'BUY',
    direction: 'long',
    confidence: 75,
    indicatorSource: 'SIGNALS',
    strategy: 'MOMENTUM_BREAKOUT',
    score: 78,
    quantity: 1,
  };

  const mockAccount = { daily_pnl: 150, kill_switch_active: false };
  logs.length = 0;

  console.log('\n  RUNNING TRADE DECISION ENGINE...\n');
  const decision = await engine.evaluate(mockSignal, finalState, mockAccount, USER);

  console.log('  TRADE DECISION:');
  console.log(LINE);
  printDecision(decision);
  console.log(LINE);

  if (logs.length > 0) {
    console.log('\n  ENGINE LOGS:');
    for (const l of logs) console.log(`    ${l}`);
  }

  return decision;
}

// ═══════════════════════════════════════════════════════════════════
//  RUN
// ═══════════════════════════════════════════════════════════════════

(async () => {
  try {
    const decisionA = await scenarioA();
    const decisionB = await scenarioB();

    console.log(`\n\n${SEP}`);
    console.log('  COMPARISON SUMMARY');
    console.log(SEP);
    console.log(`  Scenario A (bullish):  ${decisionA.action}  conviction=${decisionA.conviction_score}  delta=${decisionA.delta_target}  size=${decisionA.size_multiplier}x`);
    console.log(`  Scenario B (hostile):  ${decisionB.action}  conviction=${decisionB.conviction_score}  delta=${decisionB.delta_target}  size=${decisionB.size_multiplier}x`);
    console.log(SEP);
  } catch (err) {
    console.error('FATAL:', err);
    process.exit(1);
  }
})();
