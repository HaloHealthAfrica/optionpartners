#!/usr/bin/env node
'use strict';

/**
 * End-to-end test for the PIVOT_MB strategy.
 *
 * Tests every layer:
 *   1. Indicator detection (two trigger paths)
 *   2. Normalizer (validate + normalize)
 *   3. Signal mapping (mapIndicatorToSignal)
 *   4. Symbol state update
 *   5. Decision engine — all 5 mechanical guards
 *   6. Full pipeline scenarios (approve, block by each guard)
 *
 * Runs in-process with DB/logger stubs. No server or database required.
 */

// ── Stubs ──
const dbStub = {
  query: async () => ({ rows: [] }),
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  pool: { end: () => {} },
};
require.cache[require.resolve('../src/config/database')] = { exports: dbStub };

const logs = [];
const loggerStub = {
  info: (msg, ctx) => logs.push(`[INFO][${ctx}] ${msg}`),
  warn: (msg, ctx) => logs.push(`[WARN][${ctx}] ${msg}`),
  error: (msg, ctx) => logs.push(`[ERROR][${ctx}] ${msg}`),
};
require.cache[require.resolve('../src/utils/logger')] = { exports: loggerStub };
require.cache[require.resolve('../src/config/tradingMode')] = {
  exports: { assertSimMode: () => {} },
};

const { detectIndicatorSource } = require('../src/modules/webhooks/indicator-detector');
const { validate, normalize } = require('../src/modules/webhooks/normalizers/pivot-mb.normalizer');
const { normalizePayload } = require('../src/modules/webhooks/normalizers');
const { mapIndicatorToSignal } = require('../src/modules/sim/signal.contract');
const { SymbolStateService } = require('../src/modules/sim/symbol-state.service');
const { TradeDecisionEngine } = require('../src/modules/sim/trade-decision-engine');

const USER = 'test-user';
const SEP = '═'.repeat(72);
const LINE = '─'.repeat(72);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    console.log(`    ✗ FAIL: ${label}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  PAYLOADS
// ═══════════════════════════════════════════════════════════════════

function makePayload(overrides = {}) {
  return {
    source: 'PIVOT_MB',
    symbol: 'SPY',
    side: 'LONG',
    entry_price: 585.20,
    stop_price: 583.00,
    timestamp: Math.floor(Date.now() / 1000),
    timeframe: '15',
    trigger: 'BREAK_CLOSE',
    confluence_score: 82,
    ema_alignment_score: 78,
    atr_percentile: 72,
    pivot_position: 'AT_S1',
    mother_bar: { high: 586.00, low: 584.00, range: 2.00, retest_hold: true },
    targets: [588.00, 590.50],
    ...overrides,
  };
}

function makeShortPayload(overrides = {}) {
  return makePayload({
    side: 'SHORT',
    entry_price: 590.50,
    stop_price: 592.80,
    pivot_position: 'AT_R1',
    targets: [588.00, 585.00],
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 1: INDICATOR DETECTION
// ═══════════════════════════════════════════════════════════════════

function testDetection() {
  console.log(`\n${SEP}`);
  console.log('  TEST 1: Indicator Detection');
  console.log(SEP);

  assert(
    detectIndicatorSource({ source: 'PIVOT_MB', symbol: 'SPY' }) === 'PIVOT_MB',
    'Detects via payload.source === "PIVOT_MB"'
  );

  assert(
    detectIndicatorSource({ signal_type: 'PIVOT_MOTHERBAR', symbol: 'SPY' }) === 'PIVOT_MB',
    'Detects via payload.signal_type === "PIVOT_MOTHERBAR"'
  );

  assert(
    detectIndicatorSource({ source: 'PIVOT_MB', signal_type: 'PIVOT_MOTHERBAR' }) === 'PIVOT_MB',
    'Detects when both fields present'
  );

  assert(
    detectIndicatorSource({ symbol: 'SPY', action: 'BUY' }) !== 'PIVOT_MB',
    'Does NOT detect on unrelated payloads'
  );

  assert(
    detectIndicatorSource({ indicator: 'ORB', symbol: 'SPY' }) === 'ORB',
    'ORB detection still works (no regression)'
  );
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 2: NORMALIZER
// ═══════════════════════════════════════════════════════════════════

function testNormalizer() {
  console.log(`\n${SEP}`);
  console.log('  TEST 2: Normalizer — validate() and normalize()');
  console.log(SEP);

  // validate()
  const validPayload = makePayload();
  const vResult = validate(validPayload);
  assert(vResult.valid === true, 'Valid payload passes validation');
  assert(vResult.errors.length === 0, 'No errors on valid payload');

  const missingSymbol = validate({ ...validPayload, symbol: undefined });
  assert(missingSymbol.valid === false, 'Missing symbol fails validation');
  assert(missingSymbol.errors.some(e => e.includes('symbol')), 'Error mentions "symbol"');

  const missingSide = validate({ ...validPayload, side: '' });
  assert(missingSide.valid === false, 'Empty side fails validation');

  const missingEntry = validate({ ...validPayload, entry_price: null });
  assert(missingEntry.valid === false, 'Null entry_price fails validation');

  const missingStop = validate({ ...validPayload, stop_price: undefined });
  assert(missingStop.valid === false, 'Missing stop_price fails validation');

  const missingTs = validate({ ...validPayload, timestamp: undefined });
  assert(missingTs.valid === false, 'Missing timestamp fails validation');

  // normalize() — LONG
  const longNorm = normalize(makePayload());
  assert(longNorm.source === 'PIVOT_MB', 'normalize: source = PIVOT_MB');
  assert(longNorm.symbol === 'SPY', 'normalize: symbol uppercased');
  assert(longNorm.direction === 'long', 'normalize: LONG → long');
  assert(longNorm.action === 'BUY', 'normalize: LONG → BUY');
  assert(longNorm.strategy === 'pivot_motherbar', 'normalize: strategy = pivot_motherbar');
  assert(longNorm.entry === 585.20, 'normalize: entry from entry_price');
  assert(longNorm.stop === 583.00, 'normalize: stop from stop_price');
  assert(longNorm.score === 82, 'normalize: score from confluence_score');
  assert(longNorm.confidence === 82, 'normalize: confidence from confluence_score');
  assert(Array.isArray(longNorm.targets) && longNorm.targets.length === 2, 'normalize: targets array');
  assert(longNorm.indicatorMeta.trigger === 'BREAK_CLOSE', 'normalize: meta.trigger');
  assert(longNorm.indicatorMeta.emaAlignment === 78, 'normalize: meta.emaAlignment');
  assert(longNorm.indicatorMeta.atrPercentile === 72, 'normalize: meta.atrPercentile');
  assert(longNorm.indicatorMeta.pivotPosition === 'AT_S1', 'normalize: meta.pivotPosition');
  assert(longNorm.indicatorMeta.motherBar.retest_hold === true, 'normalize: meta.motherBar');

  // normalize() — SHORT
  const shortNorm = normalize(makeShortPayload());
  assert(shortNorm.direction === 'short', 'normalize: SHORT → short');
  assert(shortNorm.action === 'SELL', 'normalize: SHORT → SELL');

  // normalize() — BUY/SELL as side values
  const buySide = normalize(makePayload({ side: 'BUY' }));
  assert(buySide.direction === 'long', 'normalize: BUY → long');

  const sellSide = normalize(makePayload({ side: 'SELL' }));
  assert(sellSide.direction === 'short', 'normalize: SELL → short');
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 3: NORMALIZER REGISTRY + SIGNAL MAPPING
// ═══════════════════════════════════════════════════════════════════

function testSignalMapping() {
  console.log(`\n${SEP}`);
  console.log('  TEST 3: Normalizer Registry + Signal Mapping');
  console.log(SEP);

  // normalizePayload routes correctly
  const payload = makePayload();
  const { source, normalized, validation } = normalizePayload(payload);
  assert(source === 'PIVOT_MB', 'normalizePayload: detects PIVOT_MB');
  assert(validation.valid === true, 'normalizePayload: validation passes');
  assert(normalized.strategy === 'pivot_motherbar', 'normalizePayload: strategy set');

  // mapIndicatorToSignal produces valid SimSignal
  const { signal, validation: sigVal } = mapIndicatorToSignal(payload);
  assert(sigVal.valid === true, 'mapIndicatorToSignal: validation passes');
  assert(signal.symbol === 'SPY', 'SimSignal: symbol');
  assert(signal.action === 'BUY', 'SimSignal: action');
  assert(signal.direction === 'long', 'SimSignal: direction');
  assert(signal.strategy === 'pivot_motherbar', 'SimSignal: strategy');
  assert(signal.indicatorSource === 'PIVOT_MB', 'SimSignal: indicatorSource');
  assert(signal.score === 82, 'SimSignal: score');
  assert(signal.confidence === 82, 'SimSignal: confidence');
  assert(signal.limitPrice === 585.20, 'SimSignal: limitPrice from entry');
  assert(signal.stopLoss === 583.00, 'SimSignal: stopLoss from stop');
  assert(signal.takeProfit === 588.00, 'SimSignal: takeProfit from targets[0]');
  assert(signal.meta.indicatorMeta.trigger === 'BREAK_CLOSE', 'SimSignal: meta.indicatorMeta.trigger');
  assert(signal.meta.targets.length === 2, 'SimSignal: meta.targets');
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 4: SYMBOL STATE UPDATE
// ═══════════════════════════════════════════════════════════════════

async function testSymbolState() {
  console.log(`\n${SEP}`);
  console.log('  TEST 4: Symbol State Update');
  console.log(SEP);

  const svc = new SymbolStateService();
  svc._persist = async () => {};

  const payload = makePayload();
  await svc.update('PIVOT_MB', payload, USER, 'SPY');
  const state = await svc.getState(USER, 'SPY');

  assert(state.last_price === 585.20, 'State: last_price updated from entry_price');
  assert(state.latest_entry_signal != null, 'State: latest_entry_signal populated');
  assert(state.latest_entry_signal.direction === 'long', 'State: entry signal direction = long');
  assert(state.latest_entry_signal.entry_price === 585.20, 'State: entry signal entry_price');
  assert(state.latest_entry_signal.stop_loss === 583.00, 'State: entry signal stop_loss');
  assert(state.latest_entry_signal.strategy === 'pivot_motherbar', 'State: entry signal strategy');
  assert(state.latest_entry_signal.confidence === 82, 'State: entry signal confidence');
  assert(state.entry_signal_at != null, 'State: entry_signal_at timestamp set');
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 5: DECISION ENGINE — ALL GUARDS
// ═══════════════════════════════════════════════════════════════════

async function testDecisionEngine() {
  console.log(`\n${SEP}`);
  console.log('  TEST 5: Decision Engine — Mechanical Guards');
  console.log(SEP);

  const engine = new TradeDecisionEngine();
  const mockAccount = { daily_pnl: 0 };

  function buildSignal(payload) {
    const { signal } = mapIndicatorToSignal(payload);
    return signal;
  }

  function makeState(overrides = {}) {
    return {
      symbol: 'SPY',
      macro_bias: 'BULLISH',
      macro_strength: 70,
      regime: 'TREND',
      last_price: 585.20,
      chain_updated_at: new Date().toISOString(),
      chain_ok: true,
      session_phase: 'MORNING',
      latest_saty_signal: { phaseName: 'MORNING' },
      ...overrides,
    };
  }

  // ── Guard 1: Session Phase ──
  console.log(`\n  ${LINE}`);
  console.log('  Guard 1: Session Phase');

  const noSession = await engine.evaluate(
    buildSignal(makePayload()),
    makeState({ session_phase: null, latest_saty_signal: null }),
    mockAccount, USER
  );
  assert(noSession.action === 'BLOCK', 'BLOCK: no session phase (fail closed)');
  assert(noSession.rationale.some(r => r.includes('INVALID_SESSION')), 'Rationale: INVALID_SESSION');

  const afterHours = await engine.evaluate(
    buildSignal(makePayload()),
    makeState({ session_phase: 'AFTERNOON' }),
    mockAccount, USER
  );
  assert(afterHours.action === 'BLOCK', 'BLOCK: session_phase=AFTERNOON');

  const morning = await engine.evaluate(
    buildSignal(makePayload()),
    makeState({ session_phase: 'MORNING' }),
    mockAccount, USER
  );
  assert(morning.action !== 'BLOCK' || !morning.rationale.some(r => r.includes('INVALID_SESSION')),
    'PASS: session_phase=MORNING passes session guard');

  const openDrive = await engine.evaluate(
    buildSignal(makePayload()),
    makeState({ session_phase: 'OPENING_DRIVE' }),
    mockAccount, USER
  );
  assert(openDrive.action !== 'BLOCK' || !openDrive.rationale.some(r => r.includes('INVALID_SESSION')),
    'PASS: session_phase=OPENING_DRIVE passes session guard');

  // Session from SATY fallback
  const satySession = await engine.evaluate(
    buildSignal(makePayload()),
    makeState({ session_phase: null, latest_saty_signal: { phaseName: 'OPENING_DRIVE' } }),
    mockAccount, USER
  );
  assert(!satySession.rationale.some(r => r.includes('INVALID_SESSION')),
    'PASS: SATY phaseName fallback works for session guard');

  // ── Guard 2: Confluence Score ──
  console.log(`\n  ${LINE}`);
  console.log('  Guard 2: Confluence Score');

  const lowScore = await engine.evaluate(
    buildSignal(makePayload({ confluence_score: 65 })),
    makeState(), mockAccount, USER
  );
  assert(lowScore.action === 'BLOCK', 'BLOCK: confluence_score=65 < 70');
  assert(lowScore.rationale.some(r => r.includes('Confluence score')), 'Rationale: confluence');

  const exactThreshold = await engine.evaluate(
    buildSignal(makePayload({ confluence_score: 70 })),
    makeState(), mockAccount, USER
  );
  assert(!exactThreshold.rationale.some(r => r.includes('Confluence score')),
    'PASS: confluence_score=70 passes');

  // ── Guard 3: Pivot Zone ──
  console.log(`\n  ${LINE}`);
  console.log('  Guard 3: Pivot Zone');

  const longWrongPivot = await engine.evaluate(
    buildSignal(makePayload({ pivot_position: 'AT_R1' })),
    makeState(), mockAccount, USER
  );
  assert(longWrongPivot.action === 'BLOCK', 'BLOCK: long at AT_R1 (needs AT_S1/AT_S2)');

  const longAtS2 = await engine.evaluate(
    buildSignal(makePayload({ pivot_position: 'AT_S2' })),
    makeState(), mockAccount, USER
  );
  assert(!longAtS2.rationale.some(r => r.includes('pivotPosition')),
    'PASS: long at AT_S2');

  const shortWrongPivot = await engine.evaluate(
    buildSignal(makeShortPayload({ pivot_position: 'AT_S1' })),
    makeState(), mockAccount, USER
  );
  assert(shortWrongPivot.action === 'BLOCK', 'BLOCK: short at AT_S1 (needs AT_R1/AT_R2)');

  const shortAtR2 = await engine.evaluate(
    buildSignal(makeShortPayload({ pivot_position: 'AT_R2' })),
    makeState(), mockAccount, USER
  );
  assert(!shortAtR2.rationale.some(r => r.includes('pivotPosition')),
    'PASS: short at AT_R2');

  // ── Guard 4: Trigger Mode ──
  console.log(`\n  ${LINE}`);
  console.log('  Guard 4: Trigger Mode Logic');

  // BREAK_CLOSE: low ATR percentile
  const lowAtr = await engine.evaluate(
    buildSignal(makePayload({ atr_percentile: 60 })),
    makeState(), mockAccount, USER
  );
  assert(lowAtr.action === 'BLOCK', 'BLOCK: BREAK_CLOSE with atrPercentile=60 < 65');

  // BREAK_CLOSE: low EMA alignment
  const lowEma = await engine.evaluate(
    buildSignal(makePayload({ ema_alignment_score: 65 })),
    makeState(), mockAccount, USER
  );
  assert(lowEma.action === 'BLOCK', 'BLOCK: BREAK_CLOSE with emaAlignment=65 < 70');

  // BREAK_CLOSE: valid
  const validBreakClose = await engine.evaluate(
    buildSignal(makePayload({ atr_percentile: 70, ema_alignment_score: 75 })),
    makeState(), mockAccount, USER
  );
  assert(!validBreakClose.rationale.some(r => r.includes('BREAK_CLOSE requires')),
    'PASS: BREAK_CLOSE with atr=70 ema=75');

  // BREAK_RETEST: missing motherBar
  const noMother = await engine.evaluate(
    buildSignal(makePayload({ trigger: 'BREAK_RETEST', mother_bar: undefined })),
    makeState(), mockAccount, USER
  );
  assert(noMother.action === 'BLOCK', 'BLOCK: BREAK_RETEST without motherBar');

  // BREAK_RETEST: retest_hold false
  const noHold = await engine.evaluate(
    buildSignal(makePayload({ trigger: 'BREAK_RETEST', mother_bar: { retest_hold: false } })),
    makeState(), mockAccount, USER
  );
  assert(noHold.action === 'BLOCK', 'BLOCK: BREAK_RETEST with retest_hold=false');

  // BREAK_RETEST: valid
  const validRetest = await engine.evaluate(
    buildSignal(makePayload({
      trigger: 'BREAK_RETEST',
      ema_alignment_score: 75,
      mother_bar: { high: 586, low: 584, range: 2, retest_hold: true },
    })),
    makeState(), mockAccount, USER
  );
  assert(!validRetest.rationale.some(r => r.includes('BREAK_RETEST requires')),
    'PASS: BREAK_RETEST with retest_hold=true and ema=75');

  // Unknown trigger
  const unknownTrigger = await engine.evaluate(
    buildSignal(makePayload({ trigger: 'BREAK_FAKE' })),
    makeState(), mockAccount, USER
  );
  assert(unknownTrigger.action === 'BLOCK', 'BLOCK: unknown trigger type');

  // ── Guard 5: Reward Validation ──
  console.log(`\n  ${LINE}`);
  console.log('  Guard 5: Reward Validation (R:R)');

  const badRR = await engine.evaluate(
    buildSignal(makePayload({ targets: [585.50] })),
    makeState(), mockAccount, USER
  );
  assert(badRR.action === 'BLOCK', 'BLOCK: reward (0.30) < risk (2.20)');

  const noTargets = await engine.evaluate(
    buildSignal(makePayload({ targets: [] })),
    makeState(), mockAccount, USER
  );
  assert(noTargets.action === 'BLOCK', 'BLOCK: no targets');

  // entry=585.20, stop=583.00 → risk=2.20. target=587.20 → reward=2.00. reward < risk → BLOCK
  const subRR = await engine.evaluate(
    buildSignal(makePayload({ targets: [587.20] })),
    makeState(), mockAccount, USER
  );
  assert(subRR.action === 'BLOCK', 'BLOCK: reward (2.00) < risk (2.20)');

  // entry=585.20, stop=583.00 → risk=2.20. target=587.50 → reward=2.30. reward > risk → PASS
  const goodRR = await engine.evaluate(
    buildSignal(makePayload({ targets: [587.50] })),
    makeState(), mockAccount, USER
  );
  assert(goodRR.action !== 'BLOCK' || !goodRR.rationale.some(r => r.includes('R:R invalid')),
    'PASS: reward (2.30) > risk (2.20)');
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 6: FULL PIPELINE SCENARIOS
// ═══════════════════════════════════════════════════════════════════

async function testFullPipeline() {
  console.log(`\n${SEP}`);
  console.log('  TEST 6: Full Pipeline Scenarios');
  console.log(SEP);

  const engine = new TradeDecisionEngine();
  const mockAccount = { daily_pnl: 0 };

  function buildSignal(payload) {
    const { signal } = mapIndicatorToSignal(payload);
    return signal;
  }

  function makeState(overrides = {}) {
    return {
      symbol: 'SPY',
      macro_bias: 'BULLISH',
      macro_strength: 70,
      regime: 'TREND',
      last_price: 585.20,
      chain_updated_at: new Date().toISOString(),
      chain_ok: true,
      session_phase: 'OPENING_DRIVE',
      ...overrides,
    };
  }

  // ── Scenario A: Perfect BREAK_CLOSE long ──
  console.log(`\n  ${LINE}`);
  console.log('  Scenario A: Perfect BREAK_CLOSE long — should APPROVE');
  logs.length = 0;

  const decA = await engine.evaluate(
    buildSignal(makePayload()),
    makeState(), mockAccount, USER
  );

  assert(decA.action === 'BUY_CALL', `Action: ${decA.action} (expected BUY_CALL)`);
  assert(decA.conviction_score === 82, `Conviction: ${decA.conviction_score}`);
  assert(decA.contractType === 'CALL', `ContractType: ${decA.contractType}`);
  assert(decA.ticker === 'SPY', `Ticker: ${decA.ticker}`);
  assert(decA.dte_target === 7, `DTE target: ${decA.dte_target}`);
  assert(decA.dte_min === 3 && decA.dte_max === 14, `DTE range: ${decA.dte_min}-${decA.dte_max}`);
  assert(decA.delta_target > 0, `Delta target: ${decA.delta_target}`);
  assert(decA.size_multiplier >= 1, `Size: ${decA.size_multiplier}x`);
  assert(decA.risk_parameters.stop_level === 583.00, `Stop level: ${decA.risk_parameters.stop_level}`);
  assert(decA.risk_parameters.stop_source === 'PIVOT_MB_SIGNAL', `Stop source: ${decA.risk_parameters.stop_source}`);
  assert(decA.rationale.some(r => r.includes('PIVOT_MB_APPROVED')), 'Rationale includes APPROVED');

  console.log(`\n    Decision: ${decA.action} conviction=${decA.conviction_score} delta=${decA.delta_target} dte=${decA.dte_target} size=${decA.size_multiplier}x`);
  console.log(`    Stop: ${decA.risk_parameters.stop_level} (${decA.risk_parameters.stop_source})`);

  // ── Scenario B: Perfect BREAK_RETEST short ──
  console.log(`\n  ${LINE}`);
  console.log('  Scenario B: Perfect BREAK_RETEST short — should APPROVE');

  const decB = await engine.evaluate(
    buildSignal(makeShortPayload({
      trigger: 'BREAK_RETEST',
      mother_bar: { high: 591, low: 589.50, range: 1.50, retest_hold: true },
      ema_alignment_score: 80,
    })),
    makeState({ session_phase: 'MORNING' }), mockAccount, USER
  );

  assert(decB.action === 'BUY_PUT', `Action: ${decB.action} (expected BUY_PUT)`);
  assert(decB.contractType === 'PUT', `ContractType: ${decB.contractType}`);
  assert(decB.risk_parameters.stop_level === 592.80, `Stop: ${decB.risk_parameters.stop_level}`);
  assert(decB.rationale.some(r => r.includes('PIVOT_MB_APPROVED')), 'Rationale includes APPROVED');

  console.log(`\n    Decision: ${decB.action} conviction=${decB.conviction_score} delta=${decB.delta_target} dte=${decB.dte_target}`);

  // ── Scenario C: Fail-closed (missing chain) ──
  console.log(`\n  ${LINE}`);
  console.log('  Scenario C: Missing chain data — should BLOCK (fail-closed, before strategy)');

  const decC = await engine.evaluate(
    buildSignal(makePayload()),
    makeState({ chain_updated_at: null, chain_ok: false }),
    mockAccount, USER
  );

  assert(decC.action === 'BLOCK', `Action: ${decC.action}`);
  assert(decC.rationale.some(r => r.includes('FAIL_CLOSED') || r.includes('chain')),
    'Blocked by fail-closed chain check (runs before strategy dispatch)');

  console.log(`\n    Decision: ${decC.action} — ${decC.rationale.find(r => r.includes('FAIL_CLOSED') || r.includes('chain'))}`);

  // ── Scenario D: Cascading guard failures ──
  console.log(`\n  ${LINE}`);
  console.log('  Scenario D: Multiple violations — should BLOCK on first guard');

  const decD = await engine.evaluate(
    buildSignal(makePayload({ confluence_score: 50, pivot_position: 'AT_R2', targets: [] })),
    makeState({ session_phase: 'AFTERNOON' }),
    mockAccount, USER
  );

  assert(decD.action === 'BLOCK', `Action: ${decD.action}`);
  assert(decD.rationale.some(r => r.includes('INVALID_SESSION')),
    'First guard (session) catches it before confluence/pivot/targets');

  console.log(`\n    Decision: ${decD.action} — blocked by: ${decD.rationale.find(r => r.includes('PIVOT_MB_BLOCK'))}`);
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 7: NO REGRESSION — OTHER STRATEGIES
// ═══════════════════════════════════════════════════════════════════

function testNoRegression() {
  console.log(`\n${SEP}`);
  console.log('  TEST 7: No Regression — Other Strategies');
  console.log(SEP);

  // ORB still detected
  assert(
    detectIndicatorSource({ indicator: 'ORB', symbol: 'SPY', action: 'BUY' }) === 'ORB',
    'ORB detection unchanged'
  );

  // STRAT still detected
  assert(
    detectIndicatorSource({ journal: { engine: 'STRAT_V6_FULL' }, ticker: 'SPY' }) === 'STRAT',
    'STRAT detection unchanged'
  );

  // SIGNALS still detected
  assert(
    detectIndicatorSource({
      signal: { type: 'LONG' }, score: 80, trend: 'bullish', ticker: 'SPY'
    }) === 'SIGNALS',
    'SIGNALS detection unchanged'
  );

  // MTF_BIAS still detected
  assert(
    detectIndicatorSource({ source: 'MTF_BIAS_ENGINE_V3', event_id_raw: 'x' }) === 'MTF_BIAS',
    'MTF_BIAS detection unchanged'
  );

  // SATY still detected
  assert(
    detectIndicatorSource({ meta: { engine: 'SATY_PO' } }) === 'SATY_PHASE',
    'SATY_PHASE detection unchanged'
  );

  // TREND still detected
  assert(
    detectIndicatorSource({ timeframes: {}, bias: 'bullish', ticker: 'SPY' }) === 'TREND',
    'TREND detection unchanged'
  );
}

// ═══════════════════════════════════════════════════════════════════
//  RUN ALL
// ═══════════════════════════════════════════════════════════════════

(async () => {
  try {
    console.log(SEP);
    console.log('  PIVOT_MB STRATEGY — END-TO-END VALIDATION');
    console.log(SEP);

    testDetection();
    testNormalizer();
    testSignalMapping();
    await testSymbolState();
    await testDecisionEngine();
    await testFullPipeline();
    testNoRegression();

    console.log(`\n${SEP}`);
    console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
    console.log(SEP);

    if (failed > 0) {
      console.log('\n  ✗ SOME TESTS FAILED\n');
      process.exit(1);
    } else {
      console.log('\n  ✓ ALL TESTS PASSED\n');
      process.exit(0);
    }
  } catch (err) {
    console.error('\n  FATAL ERROR:', err);
    process.exit(1);
  }
})();
