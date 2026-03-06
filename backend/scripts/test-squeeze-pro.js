#!/usr/bin/env node
'use strict';

/**
 * End-to-end test for the SQUEEZE_PRO strategy.
 *
 * Tests every layer:
 *   1. Indicator detection
 *   2. Normalizer — ENTRY (validate + normalize)
 *   3. Normalizer — EXIT (validate + normalize)
 *   4. Signal mapping (mapIndicatorToSignal)
 *   5. Symbol state update (ENTRY + EXIT)
 *   6. Decision engine — all mechanical guards
 *   7. Full pipeline scenarios (approve, block by each guard)
 *   8. No regression on other strategies
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
const { validate, normalize } = require('../src/modules/webhooks/normalizers/squeeze-pro.normalizer');
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

function makeEntryPayload(overrides = {}) {
  return {
    source: 'SQUEEZE_PRO',
    signal_type: 'ENTRY',
    ticker: 'AAPL',
    exchange: 'NASDAQ',
    interval: '15',
    direction: 'LONG',
    close: 185.50,
    volume: 1500000,
    time: '1709398800000',
    timenow: '1709398860000',
    squeeze: {
      compression_score: 72.5,
      bars_compressed: 12,
      squeeze_released: true,
    },
    momentum: {
      value: 1.2345,
      direction: 'bullish',
    },
    trend: {
      fast_ema: 185.20,
      slow_ema: 184.00,
      macro_ema: 178.90,
      alignment: 'bullish',
    },
    volume_filter: {
      current_volume: 1500000,
      avg_volume_20: 1100000,
      volume_ratio: 1.36,
    },
    htf: {
      timeframe: '60',
      bias: 'bullish',
    },
    levels: {
      entry: 185.50,
      stop_loss: 184.00,
      swing_stop: 183.75,
      target_1: 188.00,
      target_2: 190.50,
    },
    ...overrides,
  };
}

function makeShortEntryPayload(overrides = {}) {
  return makeEntryPayload({
    direction: 'SHORT',
    close: 185.50,
    momentum: { value: -1.5, direction: 'bearish' },
    trend: { fast_ema: 185.80, slow_ema: 186.50, macro_ema: 190.00, alignment: 'bearish' },
    htf: { timeframe: '60', bias: 'bearish' },
    levels: {
      entry: 185.50,
      stop_loss: 186.50,
      swing_stop: 186.80,
      target_1: 183.00,
      target_2: 181.00,
    },
    ...overrides,
  });
}

function makeExitPayload(overrides = {}) {
  return {
    source: 'SQUEEZE_PRO',
    signal_type: 'EXIT',
    ticker: 'AAPL',
    exchange: 'NASDAQ',
    interval: '15',
    direction: 'LONG',
    close: 184.10,
    volume: 1340200,
    time: '1709398800000',
    timenow: '1709398860000',
    squeeze: {
      compression_score: 42.3,
      bars_compressed: 0,
      squeeze_released: true,
    },
    momentum: {
      value: -0.5612,
      direction: 'bearish',
    },
    trend: {
      fast_ema: 184.80,
      slow_ema: 185.20,
      macro_ema: 178.90,
      alignment: 'neutral',
    },
    volume_filter: {
      current_volume: 1340200,
      avg_volume_20: 1102800,
      volume_ratio: 1.22,
    },
    htf: {
      timeframe: '60',
      bias: 'bullish',
    },
    levels: {
      entry: 184.10,
      stop_loss: 185.20,
      swing_stop: 183.75,
      target_1: 184.80,
      target_2: 185.15,
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 1: INDICATOR DETECTION
// ═══════════════════════════════════════════════════════════════════

function testDetection() {
  console.log(`\n${SEP}`);
  console.log('  TEST 1: Indicator Detection');
  console.log(SEP);

  assert(
    detectIndicatorSource({ source: 'SQUEEZE_PRO', signal_type: 'ENTRY', ticker: 'AAPL' }) === 'SQUEEZE_PRO',
    'Detects ENTRY via payload.source === "SQUEEZE_PRO"'
  );

  assert(
    detectIndicatorSource({ source: 'SQUEEZE_PRO', signal_type: 'EXIT', ticker: 'AAPL' }) === 'SQUEEZE_PRO',
    'Detects EXIT via payload.source === "SQUEEZE_PRO"'
  );

  assert(
    detectIndicatorSource(makeEntryPayload()) === 'SQUEEZE_PRO',
    'Detects full ENTRY payload'
  );

  assert(
    detectIndicatorSource(makeExitPayload()) === 'SQUEEZE_PRO',
    'Detects full EXIT payload'
  );

  assert(
    detectIndicatorSource({ ticker: 'AAPL', action: 'BUY' }) !== 'SQUEEZE_PRO',
    'Does NOT detect on unrelated payloads'
  );

  // No collision with PIVOT_MB
  assert(
    detectIndicatorSource({ source: 'PIVOT_MB', symbol: 'SPY' }) === 'PIVOT_MB',
    'PIVOT_MB detection still works (no collision)'
  );

  // Fingerprint-based detection: squeeze object without explicit source
  assert(
    detectIndicatorSource({ ticker: 'SPY', direction: 'SHORT', close: 590, squeeze: { compression_score: 65 } }) === 'SQUEEZE_PRO',
    'Detects via squeeze object fingerprint (no source field)'
  );

  // Fingerprint-based detection: top-level compression_score
  assert(
    detectIndicatorSource({ ticker: 'IWM', direction: 'DOWN', close: 200, compression_score: 70 }) === 'SQUEEZE_PRO',
    'Detects via top-level compression_score (no source field)'
  );

  // Payload with squeeze object but no ticker should NOT match
  assert(
    detectIndicatorSource({ squeeze: { compression_score: 80 }, direction: 'LONG' }) !== 'SQUEEZE_PRO',
    'squeeze object without ticker does NOT match SQUEEZE_PRO'
  );
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 2: NORMALIZER — ENTRY
// ═══════════════════════════════════════════════════════════════════

function testNormalizerEntry() {
  console.log(`\n${SEP}`);
  console.log('  TEST 2: Normalizer — ENTRY validate() and normalize()');
  console.log(SEP);

  // validate() — valid ENTRY
  const validResult = validate(makeEntryPayload());
  assert(validResult.valid === true, 'Valid ENTRY payload passes validation');
  assert(validResult.errors.length === 0, 'No errors on valid ENTRY payload');

  // validate() — missing fields
  const noTicker = validate(makeEntryPayload({ ticker: '' }));
  assert(noTicker.valid === false, 'Empty ticker fails validation');
  assert(noTicker.errors.some(e => e.includes('ticker')), 'Error mentions "ticker"');

  const noDirection = validate(makeEntryPayload({ direction: null }));
  assert(noDirection.valid === false, 'Null direction fails validation');

  const noClose = validate(makeEntryPayload({ close: undefined }));
  assert(noClose.valid === false, 'Missing close fails validation');

  const noCompression = validate(makeEntryPayload({ squeeze: {} }));
  assert(noCompression.valid === false, 'Missing compression_score fails validation');
  assert(noCompression.errors.some(e => e.includes('compression_score')), 'Error mentions compression_score');

  // signal_type inference: 'INVALID' is inferred as ENTRY when direction + close present
  const badSignalType = validate(makeEntryPayload({ signal_type: 'INVALID' }));
  assert(badSignalType.valid === true, 'Invalid signal_type inferred as ENTRY when entry fields present');
  assert(badSignalType.errors.length === 0, 'No errors when signal_type inferred');

  // Truly unresolvable: no direction, no close, no signal_type
  const unresolvable = validate({ ticker: 'SPY', signal_type: 'INVALID' });
  assert(unresolvable.valid === false, 'Unresolvable signal_type fails when context missing');

  // normalize() — LONG ENTRY
  const longNorm = normalize(makeEntryPayload());
  assert(longNorm.source === 'SQUEEZE_PRO', 'normalize: source = SQUEEZE_PRO');
  assert(longNorm.symbol === 'AAPL', 'normalize: symbol uppercased');
  assert(longNorm.direction === 'long', 'normalize: LONG → long');
  assert(longNorm.action === 'BUY', 'normalize: LONG → BUY');
  assert(longNorm.strategy === 'squeeze_pro', 'normalize: strategy = squeeze_pro');
  assert(longNorm.entry === 185.50, 'normalize: entry from levels.entry');
  assert(longNorm.score === 72.5, 'normalize: score = compression_score');
  assert(longNorm.confidence > 0 && longNorm.confidence <= 100, `normalize: confidence=${longNorm.confidence} in range`);
  assert(Array.isArray(longNorm.targets) && longNorm.targets.length === 2, 'normalize: 2 targets');
  assert(longNorm.targets[0] === 188.00, 'normalize: target_1 = 188.00');
  assert(longNorm.targets[1] === 190.50, 'normalize: target_2 = 190.50');

  // Stop selection: should pick tighter of slow_ema (184.00) vs swing_stop (183.75)
  // Entry=185.50, slow_ema=184.00 (dist=1.50), swing_stop=183.75 (dist=1.75)
  // Tighter = slow_ema at 184.00
  assert(longNorm.stop === 184.00, `normalize: stop = ${longNorm.stop} (tighter of slow_ema=184 vs swing=183.75)`);

  // indicatorMeta
  assert(longNorm.indicatorMeta.signalType === 'ENTRY', 'meta: signalType = ENTRY');
  assert(longNorm.indicatorMeta.compressionScore === 72.5, 'meta: compressionScore');
  assert(longNorm.indicatorMeta.barsCompressed === 12, 'meta: barsCompressed');
  assert(longNorm.indicatorMeta.squeezeReleased === true, 'meta: squeezeReleased');
  assert(longNorm.indicatorMeta.momentum.value === 1.2345, 'meta: momentum.value');
  assert(longNorm.indicatorMeta.momentum.direction === 'bullish', 'meta: momentum.direction');
  assert(longNorm.indicatorMeta.trend.fastEma === 185.20, 'meta: trend.fastEma');
  assert(longNorm.indicatorMeta.trend.slowEma === 184.00, 'meta: trend.slowEma');
  assert(longNorm.indicatorMeta.trend.macroEma === 178.90, 'meta: trend.macroEma');
  assert(longNorm.indicatorMeta.htf.bias === 'bullish', 'meta: htf.bias');
  assert(longNorm.indicatorMeta.volume.ratio === 1.36, 'meta: volume.ratio');
  assert(longNorm.indicatorMeta.exitReason === null, 'meta: exitReason = null for ENTRY');

  // normalize() — SHORT ENTRY
  const shortNorm = normalize(makeShortEntryPayload());
  assert(shortNorm.direction === 'short', 'normalize: SHORT → short');
  assert(shortNorm.action === 'SELL', 'normalize: SHORT → SELL');

  // Stop for short: slow_ema=186.50, swing_stop=186.80
  // Entry=185.50, slow_ema dist=1.00, swing_stop dist=1.30 → tighter = slow_ema at 186.50
  assert(shortNorm.stop === 186.50, `normalize short: stop = ${shortNorm.stop} (tighter of slow_ema=186.50)`);
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 3: NORMALIZER — EXIT
// ═══════════════════════════════════════════════════════════════════

function testNormalizerExit() {
  console.log(`\n${SEP}`);
  console.log('  TEST 3: Normalizer — EXIT validate() and normalize()');
  console.log(SEP);

  // validate() — valid EXIT
  const validResult = validate(makeExitPayload());
  assert(validResult.valid === true, 'Valid EXIT payload passes validation');

  // EXIT does not require compression_score
  const exitNoSqueeze = validate(makeExitPayload({ squeeze: {} }));
  assert(exitNoSqueeze.valid === true, 'EXIT without compression_score still valid');

  // normalize() — EXIT
  const exitNorm = normalize(makeExitPayload());
  assert(exitNorm.source === 'SQUEEZE_PRO', 'exit normalize: source = SQUEEZE_PRO');
  assert(exitNorm.action === 'CLOSE', 'exit normalize: action = CLOSE');
  assert(exitNorm.direction === 'long', 'exit normalize: direction preserved');
  assert(exitNorm.entry === null, 'exit normalize: entry = null');
  assert(exitNorm.stop === null, 'exit normalize: stop = null');
  assert(exitNorm.targets.length === 0, 'exit normalize: targets empty');
  assert(exitNorm.confidence === 0, 'exit normalize: confidence = 0');
  assert(exitNorm.indicatorMeta.signalType === 'EXIT', 'exit meta: signalType = EXIT');
  assert(exitNorm.indicatorMeta.exitReason === 'INDICATOR_EXIT', 'exit meta: exitReason = INDICATOR_EXIT');
  assert(exitNorm.indicatorMeta.momentum.direction === 'bearish', 'exit meta: momentum flipped bearish');
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 4: NORMALIZER REGISTRY + SIGNAL MAPPING
// ═══════════════════════════════════════════════════════════════════

function testSignalMapping() {
  console.log(`\n${SEP}`);
  console.log('  TEST 4: Normalizer Registry + Signal Mapping');
  console.log(SEP);

  // normalizePayload routes correctly for ENTRY
  const entryPayload = makeEntryPayload();
  const { source, normalized, validation } = normalizePayload(entryPayload);
  assert(source === 'SQUEEZE_PRO', 'normalizePayload: detects SQUEEZE_PRO');
  assert(validation.valid === true, 'normalizePayload: validation passes');
  assert(normalized.strategy === 'squeeze_pro', 'normalizePayload: strategy set');

  // mapIndicatorToSignal — ENTRY
  const { signal: entrySig, validation: entryVal } = mapIndicatorToSignal(entryPayload);
  assert(entryVal.valid === true, 'mapIndicatorToSignal ENTRY: validation passes');
  assert(entrySig.symbol === 'AAPL', 'SimSignal: symbol');
  assert(entrySig.action === 'BUY', 'SimSignal: action = BUY');
  assert(entrySig.direction === 'long', 'SimSignal: direction');
  assert(entrySig.strategy === 'squeeze_pro', 'SimSignal: strategy');
  assert(entrySig.indicatorSource === 'SQUEEZE_PRO', 'SimSignal: indicatorSource');
  assert(entrySig.score === 72.5, 'SimSignal: score = compression_score');
  assert(entrySig.limitPrice === 185.50, 'SimSignal: limitPrice from entry');
  assert(entrySig.stopLoss === 184.00, 'SimSignal: stopLoss from tighter stop');
  assert(entrySig.takeProfit === 188.00, 'SimSignal: takeProfit from targets[0]');
  assert(entrySig.meta.indicatorMeta.compressionScore === 72.5, 'SimSignal: meta.indicatorMeta.compressionScore');
  assert(entrySig.meta.targets.length === 2, 'SimSignal: meta.targets');
  assert(entrySig.contractType === null, 'SimSignal: contractType = null (needs construction)');

  // mapIndicatorToSignal — EXIT
  const exitPayload = makeExitPayload();
  const { signal: exitSig, validation: exitVal } = mapIndicatorToSignal(exitPayload);
  assert(exitVal.valid === true, 'mapIndicatorToSignal EXIT: validation passes');
  assert(exitSig.action === 'CLOSE', 'EXIT SimSignal: action = CLOSE');
  assert(exitSig.indicatorSource === 'SQUEEZE_PRO', 'EXIT SimSignal: indicatorSource');
  assert(exitSig.contractType === null, 'EXIT SimSignal: contractType = null (broad match)');
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 5: SYMBOL STATE UPDATE
// ═══════════════════════════════════════════════════════════════════

async function testSymbolState() {
  console.log(`\n${SEP}`);
  console.log('  TEST 5: Symbol State Update');
  console.log(SEP);

  const svc = new SymbolStateService();
  svc._persist = async () => {};

  // ── ENTRY signal updates state ──
  console.log(`\n  ${LINE}`);
  console.log('  5a: ENTRY signal');

  const entryPayload = makeEntryPayload();
  await svc.update('SQUEEZE_PRO', entryPayload, USER, 'AAPL');
  const stateAfterEntry = await svc.getState(USER, 'AAPL');

  assert(stateAfterEntry.last_price === 185.50, 'State: last_price updated');
  assert(stateAfterEntry.local_bias === 'BULLISH', 'State: local_bias = BULLISH (price > macro_ema)');
  assert(stateAfterEntry.latest_entry_signal != null, 'State: latest_entry_signal populated');
  assert(stateAfterEntry.latest_entry_signal.direction === 'long', 'State: entry signal direction = long');
  assert(stateAfterEntry.latest_entry_signal.entry_price === 185.50, 'State: entry signal entry_price');
  assert(stateAfterEntry.latest_entry_signal.stop_loss === 184.00, 'State: entry signal stop_loss (tighter)');
  assert(stateAfterEntry.latest_entry_signal.target_1 === 188.00, 'State: entry signal target_1');
  assert(stateAfterEntry.latest_entry_signal.target_2 === 190.50, 'State: entry signal target_2');
  assert(stateAfterEntry.latest_entry_signal.strategy === 'squeeze_pro', 'State: entry signal strategy');
  assert(stateAfterEntry.latest_entry_signal.pattern === 'SQUEEZE_PRO', 'State: entry signal pattern');
  assert(stateAfterEntry.latest_entry_signal.confidence > 0, 'State: entry signal confidence > 0');
  assert(stateAfterEntry.latest_entry_signal.score === 72.5, 'State: entry signal score = compression');
  assert(stateAfterEntry.entry_signal_at != null, 'State: entry_signal_at timestamp set');

  // R:R ratio should be computed
  // entry=185.50, stop=184.00, target_1=188.00
  // R:R = |188-185.5| / |185.5-184| = 2.5/1.5 = 1.67
  assert(
    stateAfterEntry.latest_entry_signal.rr_ratio != null &&
    Math.abs(stateAfterEntry.latest_entry_signal.rr_ratio - 1.67) < 0.01,
    `State: rr_ratio = ${stateAfterEntry.latest_entry_signal.rr_ratio} (~1.67)`
  );

  // ── EXIT signal updates state but does NOT overwrite entry signal ──
  console.log(`\n  ${LINE}`);
  console.log('  5b: EXIT signal');

  svc.clearCache(USER, 'AAPL');
  const svc2 = new SymbolStateService();
  svc2._persist = async () => {};

  // First set an entry
  await svc2.update('SQUEEZE_PRO', makeEntryPayload(), USER, 'AAPL');
  const entrySignalBefore = (await svc2.getState(USER, 'AAPL')).latest_entry_signal;

  // Then send EXIT
  await svc2.update('SQUEEZE_PRO', makeExitPayload(), USER, 'AAPL');
  const stateAfterExit = await svc2.getState(USER, 'AAPL');

  assert(stateAfterExit.last_price === 184.10, 'State after EXIT: last_price updated to exit close');
  // EXIT should NOT overwrite the entry signal (it's still the same entry we had)
  assert(
    stateAfterExit.latest_entry_signal.entry_price === entrySignalBefore.entry_price,
    'State after EXIT: latest_entry_signal NOT overwritten'
  );

  // ── SHORT entry: local bias should be BEARISH when price < macro_ema ──
  console.log(`\n  ${LINE}`);
  console.log('  5c: SHORT entry — local bias');

  const svc3 = new SymbolStateService();
  svc3._persist = async () => {};
  await svc3.update('SQUEEZE_PRO', makeShortEntryPayload(), USER, 'TSLA');
  const shortState = await svc3.getState(USER, 'TSLA');

  assert(shortState.local_bias === 'BEARISH', 'State SHORT: local_bias = BEARISH (price < macro_ema)');
  assert(shortState.latest_entry_signal.direction === 'short', 'State SHORT: entry signal direction = short');
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 6: DECISION ENGINE — ALL GUARDS
// ═══════════════════════════════════════════════════════════════════

async function testDecisionEngine() {
  console.log(`\n${SEP}`);
  console.log('  TEST 6: Decision Engine — Mechanical Guards');
  console.log(SEP);

  const engine = new TradeDecisionEngine();
  const mockAccount = { daily_pnl: 0 };

  function buildSignal(payload) {
    const { signal } = mapIndicatorToSignal(payload);
    return signal;
  }

  function makeState(overrides = {}) {
    return {
      symbol: 'AAPL',
      macro_bias: 'BULLISH',
      macro_strength: 70,
      regime: 'TREND',
      last_price: 185.50,
      chain_updated_at: new Date().toISOString(),
      chain_ok: true,
      ...overrides,
    };
  }

  // ── Guard 1: Chop regime + neutral trend ──
  console.log(`\n  ${LINE}`);
  console.log('  Guard 1: Chop Guard');

  const chopNeutral = await engine.evaluate(
    buildSignal(makeEntryPayload({
      trend: { fast_ema: 185, slow_ema: 184, macro_ema: 185.50, alignment: 'neutral' },
    })),
    makeState({ regime: 'CHOP' }),
    mockAccount, USER
  );
  assert(chopNeutral.action === 'BLOCK', 'BLOCK: neutral trend + CHOP regime');
  assert(chopNeutral.rationale.some(r => r.includes('Trend neutral + CHOP')), 'Rationale: chop guard');

  // Chop with bullish trend should NOT trigger this guard
  const chopBullish = await engine.evaluate(
    buildSignal(makeEntryPayload()),
    makeState({ regime: 'CHOP' }),
    mockAccount, USER
  );
  assert(
    !chopBullish.rationale.some(r => r.includes('Trend neutral + CHOP')),
    'PASS: bullish trend in CHOP does not trigger chop guard'
  );

  // ── Guard 2: Compression Score ──
  console.log(`\n  ${LINE}`);
  console.log('  Guard 2: Compression Score');

  const lowCompression = await engine.evaluate(
    buildSignal(makeEntryPayload({ squeeze: { compression_score: 30, bars_compressed: 5, squeeze_released: true } })),
    makeState(), mockAccount, USER
  );
  assert(lowCompression.action === 'BLOCK', 'BLOCK: compression_score=30 < 40');
  assert(lowCompression.rationale.some(r => r.includes('Compression score') && r.includes('< 40')), 'Rationale: weak squeeze');

  const goodCompression = await engine.evaluate(
    buildSignal(makeEntryPayload({ squeeze: { compression_score: 45, bars_compressed: 8, squeeze_released: true } })),
    makeState(), mockAccount, USER
  );
  assert(
    !goodCompression.rationale.some(r => r.includes('Compression score') && r.includes('< 40')),
    'PASS: compression_score=45 passes guard'
  );

  // ── Guard 3: Direction ──
  console.log(`\n  ${LINE}`);
  console.log('  Guard 3: Direction');

  const noDir = await engine.evaluate(
    buildSignal(makeEntryPayload({ direction: 'NEUTRAL' })),
    makeState(), mockAccount, USER
  );
  assert(noDir.action === 'BLOCK', 'BLOCK: direction=NEUTRAL (cannot normalize)');

  // ── Guard 4: R:R Validation ──
  console.log(`\n  ${LINE}`);
  console.log('  Guard 4: R:R Validation');

  // entry=185.50, stop=184.00 (risk=1.50), target_1=186.00 (reward=0.50) → R:R=0.33 < 1.5
  const badRR = await engine.evaluate(
    buildSignal(makeEntryPayload({
      levels: { entry: 185.50, stop_loss: 184.00, swing_stop: 183.50, target_1: 186.00, target_2: 186.50 },
    })),
    makeState(), mockAccount, USER
  );
  assert(badRR.action === 'BLOCK', 'BLOCK: R:R 0.33 < 1.5');
  assert(badRR.rationale.some(r => r.includes('R:R') && r.includes('< 1.5')), 'Rationale: R:R too low');

  // entry=185.50, stop=184.00 (risk=1.50), target_1=188.00 (reward=2.50) → R:R=1.67 ≥ 1.5
  const goodRR = await engine.evaluate(
    buildSignal(makeEntryPayload()),
    makeState(), mockAccount, USER
  );
  assert(
    !goodRR.rationale.some(r => r.includes('R:R') && r.includes('< 1.5')),
    'PASS: R:R 1.67 passes guard'
  );
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 7: FULL PIPELINE SCENARIOS
// ═══════════════════════════════════════════════════════════════════

async function testFullPipeline() {
  console.log(`\n${SEP}`);
  console.log('  TEST 7: Full Pipeline Scenarios');
  console.log(SEP);

  const engine = new TradeDecisionEngine();
  const mockAccount = { daily_pnl: 0 };

  function buildSignal(payload) {
    const { signal } = mapIndicatorToSignal(payload);
    return signal;
  }

  function makeState(overrides = {}) {
    return {
      symbol: 'AAPL',
      macro_bias: 'BULLISH',
      macro_strength: 70,
      regime: 'TREND',
      last_price: 185.50,
      chain_updated_at: new Date().toISOString(),
      chain_ok: true,
      ...overrides,
    };
  }

  // ── Scenario A: Perfect long entry — high compression ──
  console.log(`\n  ${LINE}`);
  console.log('  Scenario A: High compression long ENTRY — should APPROVE');

  const decA = await engine.evaluate(
    buildSignal(makeEntryPayload({ squeeze: { compression_score: 85, bars_compressed: 20, squeeze_released: true } })),
    makeState(), mockAccount, USER
  );

  assert(decA.action === 'BUY_CALL', `Action: ${decA.action} (expected BUY_CALL)`);
  assert(decA.contractType === 'CALL', `ContractType: ${decA.contractType}`);
  assert(decA.ticker === 'AAPL', `Ticker: ${decA.ticker}`);
  assert(decA.conviction_score >= 80, `Conviction: ${decA.conviction_score} ≥ 80 (high compression)`);
  assert(decA.risk_parameters.stop_level === 184.00, `Stop level: ${decA.risk_parameters.stop_level}`);
  assert(decA.risk_parameters.stop_source === 'SQUEEZE_PRO_SIGNAL', `Stop source: ${decA.risk_parameters.stop_source}`);
  assert(decA.rationale.some(r => r.includes('SQUEEZE_PRO_APPROVED')), 'Rationale includes APPROVED');
  assert(decA.rationale.some(r => r.includes('High compression')), 'Rationale: high compression bonus');
  assert(decA.rationale.some(r => r.includes('Extended squeeze')), 'Rationale: extended squeeze bonus (20 bars)');

  // High compression should get 1.25x size boost
  assert(decA.size_multiplier > 1.0, `Size: ${decA.size_multiplier}x (should have high-compression boost)`);

  console.log(`\n    Decision: ${decA.action} conviction=${decA.conviction_score} delta=${decA.delta_target} dte=${decA.dte_target} size=${decA.size_multiplier}x`);
  console.log(`    Stop: ${decA.risk_parameters.stop_level} (${decA.risk_parameters.stop_source})`);

  // ── Scenario B: Moderate compression short entry ──
  console.log(`\n  ${LINE}`);
  console.log('  Scenario B: Moderate compression short ENTRY — should APPROVE');

  const decB = await engine.evaluate(
    buildSignal(makeShortEntryPayload()),
    makeState(), mockAccount, USER
  );

  assert(decB.action === 'BUY_PUT', `Action: ${decB.action} (expected BUY_PUT)`);
  assert(decB.contractType === 'PUT', `ContractType: ${decB.contractType}`);
  assert(decB.risk_parameters.stop_level === 186.50, `Stop: ${decB.risk_parameters.stop_level}`);
  assert(decB.rationale.some(r => r.includes('SQUEEZE_PRO_APPROVED')), 'Rationale includes APPROVED');

  console.log(`\n    Decision: ${decB.action} conviction=${decB.conviction_score} delta=${decB.delta_target} dte=${decB.dte_target}`);

  // ── Scenario C: DTE varies by timeframe ──
  console.log(`\n  ${LINE}`);
  console.log('  Scenario C: Timeframe-aware DTE selection');

  // 5min → scalp DTE (3-7)
  const scalp = await engine.evaluate(
    buildSignal(makeEntryPayload({ interval: '5' })),
    makeState(), mockAccount, USER
  );
  assert(scalp.action !== 'BLOCK', 'Scalp (5min) not blocked');
  if (scalp.action !== 'BLOCK') {
    assert(scalp.dte_target === 5, `Scalp DTE target: ${scalp.dte_target} (expected 5)`);
    assert(scalp.dte_min === 3 && scalp.dte_max === 7, `Scalp DTE range: ${scalp.dte_min}-${scalp.dte_max}`);
  }

  // 60min → swing DTE (14-30)
  const swing = await engine.evaluate(
    buildSignal(makeEntryPayload({ interval: '60' })),
    makeState(), mockAccount, USER
  );
  assert(swing.action !== 'BLOCK', 'Swing (60min) not blocked');
  if (swing.action !== 'BLOCK') {
    assert(swing.dte_target === 21, `Swing DTE target: ${swing.dte_target} (expected 21)`);
    assert(swing.dte_min === 14 && swing.dte_max === 30, `Swing DTE range: ${swing.dte_min}-${swing.dte_max}`);
  }

  // 240min → position DTE (21-45)
  const position = await engine.evaluate(
    buildSignal(makeEntryPayload({ interval: '240' })),
    makeState(), mockAccount, USER
  );
  assert(position.action !== 'BLOCK', 'Position (240min) not blocked');
  if (position.action !== 'BLOCK') {
    assert(position.dte_target === 35, `Position DTE target: ${position.dte_target} (expected 35)`);
    assert(position.dte_min === 21 && position.dte_max === 45, `Position DTE range: ${position.dte_min}-${position.dte_max}`);
  }

  // ── Scenario D: Conviction scaling from compression ──
  console.log(`\n  ${LINE}`);
  console.log('  Scenario D: Conviction scales with compression + volume');

  const lowConviction = await engine.evaluate(
    buildSignal(makeEntryPayload({
      squeeze: { compression_score: 45, bars_compressed: 3, squeeze_released: true },
      volume_filter: { current_volume: 1100000, avg_volume_20: 1100000, volume_ratio: 1.0 },
      htf: { timeframe: '60', bias: 'neutral' },
    })),
    makeState(), mockAccount, USER
  );

  const highConviction = await engine.evaluate(
    buildSignal(makeEntryPayload({
      squeeze: { compression_score: 90, bars_compressed: 25, squeeze_released: true },
      volume_filter: { current_volume: 2500000, avg_volume_20: 1100000, volume_ratio: 2.27 },
      htf: { timeframe: '60', bias: 'bullish' },
    })),
    makeState(), mockAccount, USER
  );

  if (lowConviction.action !== 'BLOCK' && highConviction.action !== 'BLOCK') {
    assert(
      highConviction.conviction_score > lowConviction.conviction_score,
      `High compression conviction (${highConviction.conviction_score}) > low (${lowConviction.conviction_score})`
    );
    assert(
      highConviction.size_multiplier > lowConviction.size_multiplier,
      `High compression size (${highConviction.size_multiplier}x) > low (${lowConviction.size_multiplier}x)`
    );
  }

  // ── Scenario E: Fail-closed (missing chain) ──
  console.log(`\n  ${LINE}`);
  console.log('  Scenario E: Missing chain data — should BLOCK (fail-closed)');

  const decE = await engine.evaluate(
    buildSignal(makeEntryPayload()),
    makeState({ chain_updated_at: null, chain_ok: false }),
    mockAccount, USER
  );

  assert(decE.action === 'BLOCK', `Action: ${decE.action}`);
  assert(decE.rationale.some(r => r.includes('FAIL_CLOSED') || r.includes('chain')),
    'Blocked by fail-closed chain check');

  console.log(`\n    Decision: ${decE.action} — ${decE.rationale.find(r => r.includes('FAIL_CLOSED'))}`);
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 8: NO REGRESSION — OTHER STRATEGIES
// ═══════════════════════════════════════════════════════════════════

function testNoRegression() {
  console.log(`\n${SEP}`);
  console.log('  TEST 8: No Regression — Other Strategies');
  console.log(SEP);

  assert(
    detectIndicatorSource({ source: 'PIVOT_MB', symbol: 'SPY' }) === 'PIVOT_MB',
    'PIVOT_MB detection unchanged'
  );

  assert(
    detectIndicatorSource({ indicator: 'ORB', symbol: 'SPY', action: 'BUY' }) === 'ORB',
    'ORB detection unchanged'
  );

  assert(
    detectIndicatorSource({ journal: { engine: 'STRAT_V6_FULL' }, ticker: 'SPY' }) === 'STRAT',
    'STRAT detection unchanged'
  );

  assert(
    detectIndicatorSource({
      signal: { type: 'LONG' }, score: 80, trend: 'bullish', ticker: 'SPY',
    }) === 'SIGNALS',
    'SIGNALS detection unchanged'
  );

  assert(
    detectIndicatorSource({ source: 'MTF_BIAS_ENGINE_V3', event_id_raw: 'x' }) === 'MTF_BIAS',
    'MTF_BIAS detection unchanged'
  );

  assert(
    detectIndicatorSource({ meta: { engine: 'SATY_PO' } }) === 'SATY_PHASE',
    'SATY_PHASE detection unchanged'
  );

  assert(
    detectIndicatorSource({ timeframes: {}, bias: 'bullish', ticker: 'SPY' }) === 'TREND',
    'TREND detection unchanged'
  );

  // SQUEEZE_PRO payload should NOT match SIGNALS or STRAT
  const sqPayload = makeEntryPayload();
  assert(
    detectIndicatorSource(sqPayload) === 'SQUEEZE_PRO',
    'SQUEEZE_PRO not misclassified as another indicator'
  );
}

// ═══════════════════════════════════════════════════════════════════
//  RUN ALL
// ═══════════════════════════════════════════════════════════════════

(async () => {
  try {
    console.log(SEP);
    console.log('  SQUEEZE_PRO STRATEGY — END-TO-END VALIDATION');
    console.log(SEP);

    testDetection();
    testNormalizerEntry();
    testNormalizerExit();
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
