#!/usr/bin/env node
'use strict';

/**
 * Validation script for Reversal Indicator webhook integration.
 * Tests: indicator detection, normalizer, filters, and direction mapping.
 */

const { detectIndicatorSource } = require('../src/modules/webhooks/indicator-detector');
const { normalizePayload } = require('../src/modules/webhooks/normalizers');
const { validatePayload, generateDedupeKey } = require('../src/modules/webhooks/webhook.validator');

const PAYLOADS = {
  EME_CALL_ZONE: {
    symbol: 'SPY',
    timestamp: '2025-03-08 14:30:00',
    price: 450.25,
    expected_move: 2.15,
    distance_to_upper: 1.80,
    distance_to_lower: 0.35,
    signal_type: 'EM_CALL_ZONE',
    confidence: 72,
  },
  EME_PUT_ZONE: {
    symbol: 'QQQ',
    timestamp: '2025-03-08 14:30:00',
    price: 385.50,
    expected_move: 2.00,
    signal_type: 'EM_PUT_ZONE',
    confidence: 65,
  },
  EME_BREAKOUT: {
    symbol: 'SPY',
    timestamp: '2025-03-08 14:30:00',
    price: 450.25,
    expected_move: 2.15,
    signal_type: 'EM_BREAKOUT',
    confidence: 80,
  },
  SPE_PUT_FAVORABLE: {
    symbol: 'SPY',
    timestamp: '2025-03-08 14:30:00',
    price: 450.25,
    signal: 'PUT_SPREAD_FAVORABLE',
    probability_score: 72.5,
    atr: 2.15,
    distance_from_high: 0.12,
    distance_from_low: 0.88,
    trend_state: 'BULLISH',
  },
  SPE_CALL_FAVORABLE: {
    symbol: 'IWM',
    timestamp: '2025-03-08 14:30:00',
    price: 210.50,
    signal: 'CALL_SPREAD_FAVORABLE',
    probability_score: 68,
    atr: 1.50,
    trend_state: 'BULLISH',
  },
  STRAT_SETUP: {
    signal: 'STRAT_SETUP',
    setup_id: 'SPY-5-1741456200000',
    symbol: 'SPY',
    pattern: '212_FORMING_BULL',
    timeframe: '5',
    trigger_level: 450.50,
    setup_low: 448.20,
    expects_trigger: true,
  },
  STRAT_TRIGGER: {
    signal: 'STRAT_TRIGGER',
    setup_id: 'SPY-5-1741456200000',
    symbol: 'SPY',
    pattern: '212_BULL',
    timeframe: '5',
    confidence_score: 78,
  },
};

const EXPECTED = {
  EME_CALL_ZONE: { source: 'REVERSAL', direction: 'long', strategy: 'reversal_eme', valid: true },
  EME_PUT_ZONE: { source: 'REVERSAL', direction: 'short', strategy: 'reversal_eme', valid: true },
  EME_BREAKOUT: { source: 'REVERSAL', valid: false, reason: 'EM_BREAKOUT skip' },
  SPE_PUT_FAVORABLE: { source: 'REVERSAL', direction: 'short', strategy: 'reversal_spe', valid: true },
  SPE_CALL_FAVORABLE: { source: 'REVERSAL', direction: 'long', strategy: 'reversal_spe', valid: true },
  STRAT_SETUP: { source: 'REVERSAL', valid: false, contextOnly: true },
  STRAT_TRIGGER: { source: 'REVERSAL', direction: 'long', strategy: 'reversal_strat', valid: true },
};

function run() {
  let passed = 0;
  let failed = 0;

  console.log('\n=== Reversal Indicator Validation ===\n');

  for (const [name, payload] of Object.entries(PAYLOADS)) {
    const exp = EXPECTED[name];
    console.log(`\n--- ${name} ---`);

    // 1. Indicator detection
    const source = detectIndicatorSource(payload);
    const srcOk = source === 'REVERSAL';
    console.log(`  Detection: ${source} ${srcOk ? '✓' : '✗ (expected REVERSAL)'}`);
    if (!srcOk) failed++;
    else passed++;

    // 2. Payload validation (webhook.validator)
    const payloadResult = validatePayload(payload);
    console.log(`  Payload validation: ${payloadResult.valid ? '✓' : '✗'}`);

    // 3. Normalizer (only for tradeable signals; STRAT_SETUP doesn't go through normalizer)
    if (exp.contextOnly) {
      console.log(`  STRAT_SETUP: context-only (no normalizer) ✓`);
      passed++;
      continue;
    }

    const { source: normSource, normalized, validation } = normalizePayload(payload);

    if (exp.valid === false) {
      const expectReject = !validation.valid;
      console.log(`  Normalizer reject: ${expectReject ? '✓ (expected)' : '✗ (should reject)'}`);
      if (expectReject) passed++;
      else failed++;
      continue;
    }

    const dirOk = !exp.direction || normalized?.direction === exp.direction;
    const stratOk = !exp.strategy || normalized?.strategy === exp.strategy;
    const validOk = validation.valid;

    console.log(`  Normalizer valid: ${validOk ? '✓' : '✗'}`);
    console.log(`  Direction: ${normalized?.direction} ${dirOk ? '✓' : `✗ (expected ${exp.direction})`}`);
    console.log(`  Strategy: ${normalized?.strategy} ${stratOk ? '✓' : `✗ (expected ${exp.strategy})`}`);

    if (validOk && dirOk && stratOk) passed++;
    else failed++;
  }

  // 4. Dedupe key generation
  console.log('\n--- Dedupe key ---');
  const dedupeKey = generateDedupeKey(PAYLOADS.EME_CALL_ZONE);
  const dedupeOk = typeof dedupeKey === 'string' && dedupeKey.length > 0;
  console.log(`  REVERSAL dedupe key: ${dedupeOk ? '✓' : '✗'}`);
  if (dedupeOk) passed++;
  else failed++;

  // 5. Guide alignment check
  console.log('\n--- Guide alignment ---');
  const guideChecks = [
    ['EM_CALL_ZONE → bullish → sell put spread', PAYLOADS.EME_CALL_ZONE, 'long'],
    ['EM_PUT_ZONE → bearish → sell call spread', PAYLOADS.EME_PUT_ZONE, 'short'],
    ['PUT_SPREAD_FAVORABLE → bearish → sell call spread', PAYLOADS.SPE_PUT_FAVORABLE, 'short'],
    ['CALL_SPREAD_FAVORABLE → bullish → sell put spread', PAYLOADS.SPE_CALL_FAVORABLE, 'long'],
    ['212_BULL → bullish → sell put spread', PAYLOADS.STRAT_TRIGGER, 'long'],
  ];

  for (const [desc, p, expectedDir] of guideChecks) {
    const { normalized, validation } = normalizePayload(p);
    const ok = validation.valid && normalized?.direction === expectedDir;
    console.log(`  ${desc}: ${ok ? '✓' : '✗'}`);
    if (ok) passed++;
    else failed++;
  }

  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
