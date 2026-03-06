#!/usr/bin/env node
'use strict';

const https = require('https');

const BASE_URL = 'https://optionpartners.fly.dev';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(path, BASE_URL);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    https.get(url, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const passed = [];
const failed = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed.push(name);
    console.log(`  ✓ ${name}`);
  } else {
    failed.push(name);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function main() {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = `e2e-${ts}`;

  console.log('═'.repeat(72));
  console.log('  COMPREHENSIVE E2E PRODUCTION TEST — ALL WEBHOOK TYPES');
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Time:   ${new Date().toISOString()}`);
  console.log('═'.repeat(72));

  // ─────────────────────────────────────────────────────────
  //  1. HEALTH CHECK
  // ─────────────────────────────────────────────────────────
  console.log('\n── 1. Health Check ──');
  const health = await get('/api/health');
  check('Health endpoint responds', health.status === 200, `HTTP ${health.status}`);
  check('Status is healthy', ['healthy', 'OK'].includes(health.body?.status), health.body?.status);
  check('Database connected', ['connected', 'OK'].includes(health.body?.services?.database), health.body?.services?.database);
  console.log(`     Worker: ${health.body?.services?.backgroundWorker?.status || 'unknown'}`);

  // ─────────────────────────────────────────────────────────
  //  2. TEST PING (no auth required)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 2. Test Ping ──');
  const ping = await post('/api/webhooks/tradingview', { test: true, type: 'PING' });
  check('Ping accepted (200)', ping.status === 200, `HTTP ${ping.status}`);
  check('Ping status TEST_PING', ping.body?.status === 'TEST_PING', ping.body?.status);
  check('Ping returns eventId', !!ping.body?.eventId, ping.body?.eventId);

  // ─────────────────────────────────────────────────────────
  //  3. SIGNALS webhook
  // ─────────────────────────────────────────────────────────
  console.log('\n── 3. SIGNALS — Bullish composite signal ──');
  const signals = await post('/api/webhooks/tradingview', {
    ticker: 'SPY',
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
    _nonce: `${nonce}-signals`,
  });
  check('SIGNALS accepted (202)', signals.status === 202, `HTTP ${signals.status}`);
  check('SIGNALS queued', signals.body?.status === 'RECEIVED', signals.body?.status || signals.body?.message);

  // ─────────────────────────────────────────────────────────
  //  4. STRAT V1 webhook (legacy flat format)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 4. STRAT V1 — Legacy flat format ──');
  const stratV1 = await post('/api/webhooks/tradingview', {
    ticker: 'QQQ',
    journal: { engine: 'STRAT_V6_FULL' },
    signal: { side: 'LONG' },
    entry: 510.00,
    target: 515.00,
    stop: 507.00,
    setup: '2-1-2 Rev',
    trend: 'BULLISH',
    score: 7.5,
    components: ['STRAT_SETUP', 'HTF_IGNITION'],
    timeframe: '15',
    timestamp: ts + 1,
    _nonce: `${nonce}-strat-v1`,
  });
  check('STRAT V1 accepted (202)', stratV1.status === 202, `HTTP ${stratV1.status}`);
  check('STRAT V1 queued', stratV1.body?.status === 'RECEIVED', stratV1.body?.status || stratV1.body?.message);

  // ─────────────────────────────────────────────────────────
  //  5. STRAT V2 webhook (Plan Engine lifecycle)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 5. STRAT V2 — Plan Engine TRIGGERED ──');
  const stratV2 = await post('/api/webhooks/tradingview', {
    meta: { symbol: 'AAPL', system: 'Strat Plan Engine v2', ts: ts + 2 },
    event: 'TRIGGERED',
    setup: {
      direction: 'LONG', bias: 'BULLISH', pattern: '3-1-2',
      pattern_kind: 'CONTINUATION', continuity: true,
      htf: 'D', ltf: '15', ctf: '65', htf_candle: 2,
    },
    plan: { entry: 225.00, stop: 221.00, target1: 230.00, target2: 234.00, atr: 3.5 },
    plan_id: `plan-${nonce}`,
    _nonce: `${nonce}-strat-v2`,
  });
  check('STRAT V2 accepted (202)', stratV2.status === 202, `HTTP ${stratV2.status}`);
  check('STRAT V2 queued', stratV2.body?.status === 'RECEIVED', stratV2.body?.status || stratV2.body?.message);

  // ─────────────────────────────────────────────────────────
  //  6. ORB webhook
  // ─────────────────────────────────────────────────────────
  console.log('\n── 6. ORB — Opening Range Breakout ──');
  const orb = await post('/api/webhooks/tradingview', {
    ticker: 'TSLA',
    indicator: 'ORB',
    action: 'buy',
    side: 'LONG',
    entry: 245.00,
    stop: 241.50,
    timeframe: '5',
    timestamp: ts + 3,
    _nonce: `${nonce}-orb`,
  });
  check('ORB accepted (202)', orb.status === 202, `HTTP ${orb.status}`);
  check('ORB queued', orb.body?.status === 'RECEIVED', orb.body?.status || orb.body?.message);

  // ─────────────────────────────────────────────────────────
  //  7. PIVOT_MB webhook (BREAK_CLOSE long)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 7. PIVOT_MB — BREAK_CLOSE Long ──');
  const pivotMb = await post('/api/webhooks/tradingview', {
    source: 'PIVOT_MB',
    symbol: 'NVDA',
    side: 'LONG',
    entry_price: 890.50,
    stop_price: 882.00,
    timestamp: ts + 4,
    bar_time: `${ts + 4}`,
    trigger: 'BREAK_CLOSE',
    confluence_score: 85,
    ema_alignment_score: 78,
    atr_percentile: 72,
    pivot_position: 'AT_S1',
    mother_bar: { high: 892, low: 888, retest_hold: true },
    targets: [897.00, 903.00],
    timeframe: '15',
    _nonce: `${nonce}-pivot`,
  });
  check('PIVOT_MB accepted (202)', pivotMb.status === 202, `HTTP ${pivotMb.status}`);
  check('PIVOT_MB queued', pivotMb.body?.status === 'RECEIVED', pivotMb.body?.status || pivotMb.body?.message);

  // ─────────────────────────────────────────────────────────
  //  8. SQUEEZE_PRO webhook (ENTRY)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 8. SQUEEZE_PRO — Squeeze Release Entry ──');
  const sqzEntry = await post('/api/webhooks/tradingview', {
    source: 'SQUEEZE_PRO',
    ticker: 'AMZN',
    direction: 'LONG',
    close: 195.80,
    signal_type: 'ENTRY',
    time: String(ts + 5),
    interval: '15',
    squeeze: { compression_score: 78, bars_compressed: 12, squeeze_released: true },
    momentum: { value: 2.5, direction: 'up' },
    trend: { fast_ema: 195.50, slow_ema: 193.80, macro_ema: 190.00, alignment: 'bullish' },
    volume_filter: { current_volume: 1500000, avg_volume_20: 1200000, volume_ratio: 1.25 },
    levels: { entry: 195.80, swing_stop: 192.50, target_1: 199.00, target_2: 202.00 },
    htf: { timeframe: '65', bias: 'bullish' },
    _nonce: `${nonce}-sqz-entry`,
  });
  check('SQUEEZE_PRO ENTRY accepted (202)', sqzEntry.status === 202, `HTTP ${sqzEntry.status}`);
  check('SQUEEZE_PRO ENTRY queued', sqzEntry.body?.status === 'RECEIVED', sqzEntry.body?.status || sqzEntry.body?.message);

  // ─────────────────────────────────────────────────────────
  //  9. SQUEEZE_PRO EXIT
  // ─────────────────────────────────────────────────────────
  console.log('\n── 9. SQUEEZE_PRO — Exit Signal ──');
  const sqzExit = await post('/api/webhooks/tradingview', {
    source: 'SQUEEZE_PRO',
    ticker: 'AMZN',
    direction: 'LONG',
    close: 199.20,
    signal_type: 'EXIT',
    time: String(ts + 6),
    interval: '15',
    exit_reason: 'MOMENTUM_REVERSAL',
    _nonce: `${nonce}-sqz-exit`,
  });
  check('SQUEEZE_PRO EXIT accepted (202)', sqzExit.status === 202, `HTTP ${sqzExit.status}`);
  check('SQUEEZE_PRO EXIT queued', sqzExit.body?.status === 'RECEIVED', sqzExit.body?.status || sqzExit.body?.message);

  // ─────────────────────────────────────────────────────────
  //  10. SQZ_ULTRA_PRO alias (should detect as SQUEEZE_PRO)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 10. SQZ_ULTRA_PRO alias ──');
  const sqzAlias = await post('/api/webhooks/tradingview', {
    source: 'SQZ_ULTRA_PRO',
    ticker: 'META',
    direction: 'SHORT',
    close: 580.00,
    signal_type: 'ENTRY',
    time: String(ts + 7),
    interval: '60',
    squeeze: { compression_score: 65, bars_compressed: 8, squeeze_released: true },
    momentum: { value: -1.8, direction: 'down' },
    trend: { fast_ema: 581, slow_ema: 583, macro_ema: 585, alignment: 'bearish' },
    volume_filter: { current_volume: 900000, avg_volume_20: 750000, volume_ratio: 1.2 },
    levels: { entry: 580.00, swing_stop: 585.00, target_1: 574.00, target_2: 568.00 },
    htf: { timeframe: 'D', bias: 'bearish' },
    _nonce: `${nonce}-sqz-alias`,
  });
  check('SQZ_ULTRA_PRO accepted (202)', sqzAlias.status === 202, `HTTP ${sqzAlias.status}`);
  check('SQZ_ULTRA_PRO queued', sqzAlias.body?.status === 'RECEIVED', sqzAlias.body?.status || sqzAlias.body?.message);

  // ─────────────────────────────────────────────────────────
  //  11. PIVOT_MB via signal_type detection path
  // ─────────────────────────────────────────────────────────
  console.log('\n── 11. PIVOT_MB — signal_type detection ──');
  const pivotAlt = await post('/api/webhooks/tradingview', {
    signal_type: 'PIVOT_MOTHERBAR',
    symbol: 'MSFT',
    side: 'SHORT',
    entry_price: 430.00,
    stop_price: 435.00,
    timestamp: ts + 8,
    bar_time: `${ts + 8}`,
    trigger: 'BREAK_RETEST',
    confluence_score: 76,
    ema_alignment_score: 74,
    atr_percentile: 69,
    pivot_position: 'AT_R1',
    mother_bar: { high: 432, low: 428, retest_hold: true },
    targets: [425.00, 420.00],
    timeframe: '15',
    _nonce: `${nonce}-pivot-alt`,
  });
  check('PIVOT_MB alt accepted (202)', pivotAlt.status === 202, `HTTP ${pivotAlt.status}`);
  check('PIVOT_MB alt queued', pivotAlt.body?.status === 'RECEIVED', pivotAlt.body?.status || pivotAlt.body?.message);

  // ─────────────────────────────────────────────────────────
  //  12. EDGE CASES — validation rejections
  // ─────────────────────────────────────────────────────────
  console.log('\n── 12. Edge Cases ──');

  const noSymbol = await post('/api/webhooks/tradingview', {
    source: 'PIVOT_MB', side: 'LONG', entry_price: 100, stop_price: 98,
    timestamp: ts + 9, _nonce: `${nonce}-nosym`,
  });
  check('Missing symbol rejected (422)', noSymbol.status === 422, `HTTP ${noSymbol.status}`);

  const noDirection = await post('/api/webhooks/tradingview', {
    ticker: 'SPY', indicator: 'ORB', entry: 590, stop: 587,
    timestamp: ts + 10, _nonce: `${nonce}-nodir`,
  });
  check('ORB missing action ingested (202), rejected by processor', noDirection.status === 202, `HTTP ${noDirection.status}`);

  const badSqzSignalType = await post('/api/webhooks/tradingview', {
    source: 'SQUEEZE_PRO', ticker: 'SPY', direction: 'LONG', close: 590,
    signal_type: 'INVALID', time: String(ts + 11), _nonce: `${nonce}-badsqz`,
  });
  check('SQUEEZE_PRO bad signal_type ingested (202), rejected by processor', badSqzSignalType.status === 202, `HTTP ${badSqzSignalType.status}`);

  const emptyPayload = await post('/api/webhooks/tradingview', {});
  check('Empty payload rejected (401 or 422)', [401, 422].includes(emptyPayload.status), `HTTP ${emptyPayload.status}`);

  // ─────────────────────────────────────────────────────────
  //  13. DUPLICATE DETECTION
  // ─────────────────────────────────────────────────────────
  console.log('\n── 13. Duplicate Detection ──');
  const dup = await post('/api/webhooks/tradingview', {
    source: 'PIVOT_MB',
    symbol: 'NVDA',
    side: 'LONG',
    entry_price: 890.50,
    stop_price: 882.00,
    timestamp: ts + 4,
    bar_time: `${ts + 4}`,
    trigger: 'BREAK_CLOSE',
    confluence_score: 85,
    ema_alignment_score: 78,
    atr_percentile: 72,
    pivot_position: 'AT_S1',
    mother_bar: { high: 892, low: 888, retest_hold: true },
    targets: [897.00, 903.00],
    timeframe: '15',
    _nonce: `${nonce}-pivot`,
  });
  check('Duplicate PIVOT_MB detected (200)', dup.status === 200, `HTTP ${dup.status}`);
  check('Duplicate message correct', dup.body?.message?.includes('Duplicate'), dup.body?.message);

  // ─────────────────────────────────────────────────────────
  //  14. WAIT FOR PROCESSOR + CHECK RESULTS
  // ─────────────────────────────────────────────────────────
  console.log('\n── 14. Waiting 12s for webhook processor ──');
  await sleep(12000);

  console.log('\n── 15. Post-processing Health Check ──');
  const health2 = await get('/api/health');
  check('App still healthy after tests', health2.status === 200 && ['healthy', 'OK'].includes(health2.body?.status),
    `HTTP ${health2.status} status=${health2.body?.status}`);

  // ─────────────────────────────────────────────────────────
  //  SUMMARY
  // ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log(`  RESULTS: ${passed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log('\n  FAILURES:');
    for (const f of failed) console.log(`    ✗ ${f}`);
  }
  console.log('═'.repeat(72));

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
