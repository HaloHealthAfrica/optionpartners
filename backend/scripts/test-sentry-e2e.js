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

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const ts = Date.now();
  console.log('═'.repeat(70));
  console.log('  SENTRY E2E PRODUCTION TEST');
  console.log('═'.repeat(70));
  console.log();

  // 1. Health check
  console.log('── Health Check ──');
  const health = await get('/api/health');
  console.log(`  Status: ${health.body.status} (HTTP ${health.status})`);
  console.log(`  DB: ${health.body.services?.database}`);
  console.log(`  Worker: ${health.body.services?.backgroundWorker?.status}`);
  console.log();

  // 2. Valid PIVOT_MB BREAK_CLOSE long
  console.log('── Test 1: PIVOT_MB BREAK_CLOSE long ──');
  const r1 = await post('/api/webhooks/tradingview', {
    source: 'PIVOT_MB',
    symbol: 'SPY',
    side: 'LONG',
    entry_price: 590.50,
    stop_price: 583.00,
    timestamp: `2026-03-01T17:${String(Math.floor(ts / 60000) % 60).padStart(2,'0')}:${String(ts % 60).padStart(2,'0')}Z`,
    trigger: 'BREAK_CLOSE',
    confluence_score: 82,
    ema_alignment_score: 75,
    atr_percentile: 70,
    pivot_position: 'AT_S1',
    mother_bar: { high: 591, low: 589, retest_hold: true },
    targets: [593.50, 596.00],
    timeframe: '15',
    _nonce: `e2e-${ts}-1`,
  });
  console.log(`  HTTP ${r1.status}: ${JSON.stringify(r1.body)}`);
  console.log();

  // 3. Valid PIVOT_MB BREAK_RETEST short
  console.log('── Test 2: PIVOT_MB BREAK_RETEST short ──');
  const r2 = await post('/api/webhooks/tradingview', {
    source: 'PIVOT_MB',
    symbol: 'QQQ',
    side: 'SHORT',
    entry_price: 510.20,
    stop_price: 514.00,
    timestamp: `2026-03-01T17:${String(Math.floor((ts+1) / 60000) % 60).padStart(2,'0')}:${String((ts+1) % 60).padStart(2,'0')}Z`,
    trigger: 'BREAK_RETEST',
    confluence_score: 78,
    ema_alignment_score: 72,
    atr_percentile: 68,
    pivot_position: 'AT_R1',
    mother_bar: { high: 511, low: 509, retest_hold: true },
    targets: [507.50, 505.00],
    timeframe: '15',
    _nonce: `e2e-${ts}-2`,
  });
  console.log(`  HTTP ${r2.status}: ${JSON.stringify(r2.body)}`);
  console.log();

  // 4. Invalid PIVOT_MB (missing entry_price) — should reject with validation error
  console.log('── Test 3: PIVOT_MB invalid (missing entry_price) ──');
  const r3 = await post('/api/webhooks/tradingview', {
    source: 'PIVOT_MB',
    symbol: 'AAPL',
    side: 'LONG',
    stop_price: 220.00,
    timestamp: `2026-03-01T17:${String(Math.floor((ts+2) / 60000) % 60).padStart(2,'0')}:${String((ts+2) % 60).padStart(2,'0')}Z`,
    trigger: 'BREAK_CLOSE',
    confluence_score: 80,
    _nonce: `e2e-${ts}-3`,
  });
  console.log(`  HTTP ${r3.status}: ${JSON.stringify(r3.body)}`);
  console.log();

  // 5. PIVOT_MB low confluence (should get processed but blocked by engine)
  console.log('── Test 4: PIVOT_MB low confluence (should block) ──');
  const r4 = await post('/api/webhooks/tradingview', {
    source: 'PIVOT_MB',
    symbol: 'MSFT',
    side: 'LONG',
    entry_price: 425.00,
    stop_price: 420.00,
    timestamp: `2026-03-01T17:${String(Math.floor((ts+3) / 60000) % 60).padStart(2,'0')}:${String((ts+3) % 60).padStart(2,'0')}Z`,
    trigger: 'BREAK_CLOSE',
    confluence_score: 50,
    ema_alignment_score: 75,
    atr_percentile: 70,
    pivot_position: 'AT_S1',
    targets: [430.00],
    timeframe: '15',
    _nonce: `e2e-${ts}-4`,
  });
  console.log(`  HTTP ${r4.status}: ${JSON.stringify(r4.body)}`);
  console.log();

  // 6. SATY_PHASE webhook (context update, should not break)
  console.log('── Test 5: SATY_PHASE context webhook ──');
  const r5 = await post('/api/webhooks/tradingview', {
    indicator: 'SATY_PHASE',
    ticker: 'SPY',
    phaseName: 'MORNING',
    timestamp: `2026-03-01T17:${String(Math.floor((ts+4) / 60000) % 60).padStart(2,'0')}:${String((ts+4) % 60).padStart(2,'0')}Z`,
    regime_context: { local_bias: 'BULLISH' },
    _nonce: `e2e-${ts}-5`,
  });
  console.log(`  HTTP ${r5.status}: ${JSON.stringify(r5.body)}`);
  console.log();

  // 7. Malformed JSON (should trigger Sentry if error handling is wrong)
  console.log('── Test 6: Completely empty payload ──');
  const r6 = await post('/api/webhooks/tradingview', {});
  console.log(`  HTTP ${r6.status}: ${JSON.stringify(r6.body)}`);
  console.log();

  // 8. Test ping
  console.log('── Test 7: Ping webhook ──');
  const r7 = await post('/api/webhooks/tradingview', { test: true, type: 'PING' });
  console.log(`  HTTP ${r7.status}: ${JSON.stringify(r7.body)}`);
  console.log();

  // Wait for processor to pick up events
  console.log('── Waiting 10s for webhook processor to run ──');
  await sleep(10000);

  // 9. Check webhook stats
  console.log('── Webhook Stats ──');
  const stats = await get('/api/webhooks/stats');
  console.log(`  ${JSON.stringify(stats.body, null, 2)}`);
  console.log();

  // 10. Check Sentry test endpoint
  console.log('── Test 8: Sentry verification (debug route) ──');
  const r8 = await get('/debug-sentry');
  console.log(`  HTTP ${r8.status}: ${typeof r8.body === 'string' ? r8.body.substring(0, 200) : JSON.stringify(r8.body)}`);
  console.log();

  console.log('═'.repeat(70));
  console.log('  ALL TESTS COMPLETE — check Sentry dashboard for captured events');
  console.log('═'.repeat(70));
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
