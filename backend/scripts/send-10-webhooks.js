#!/usr/bin/env node
'use strict';

const https = require('https');

const BASE_URL = process.argv[2] || process.env.WEBHOOK_URL || 'https://marketplaybook.fly.dev';

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const WEBHOOKS = [
  { name: 'SIGNALS SPY', payload: (ts, n) => ({
    ticker: 'SPY',
    signal: { type: 'BULLISH', bar_time: `${ts}`, quality: 'A', ai_score: 8.2 },
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
    _nonce: `test-${ts}-${n}`,
  })},
  { name: 'SIGNALS QQQ', payload: (ts, n) => ({
    ticker: 'QQQ',
    signal: { type: 'BULLISH', bar_time: `${ts}`, quality: 'B', ai_score: 7.5 },
    direction: 'LONG',
    score: 75,
    trend: 'BULLISH',
    entry: { price: 510.00, stop_loss: 507.00, target_1: 515.00 },
    confidence: 72,
    timeframe: '15',
    timestamp: ts,
    _nonce: `test-${ts}-${n}`,
  })},
  { name: 'STRAT V1', payload: (ts, n) => ({
    ticker: 'AAPL',
    journal: { engine: 'STRAT_V6_FULL' },
    signal: { side: 'LONG' },
    entry: 225.00,
    target: 230.00,
    stop: 221.00,
    setup: '2-1-2 Rev',
    trend: 'BULLISH',
    score: 7.5,
    timeframe: '15',
    timestamp: ts,
    _nonce: `test-${ts}-${n}`,
  })},
  { name: 'STRAT V2', payload: (ts, n) => ({
    meta: { symbol: 'NVDA', system: 'Strat Plan Engine v2', ts },
    event: 'TRIGGERED',
    setup: { direction: 'LONG', bias: 'BULLISH', pattern: '3-1-2' },
    plan: { entry: 890.00, stop: 882.00, target1: 900.00, target2: 910.00 },
    plan_id: `plan-test-${ts}-${n}`,
    _nonce: `test-${ts}-${n}`,
  })},
  { name: 'ORB', payload: (ts, n) => ({
    ticker: 'TSLA',
    indicator: 'ORB',
    action: 'buy',
    side: 'LONG',
    entry: 245.00,
    stop: 241.50,
    timeframe: '5',
    timestamp: ts,
    _nonce: `test-${ts}-${n}`,
  })},
  { name: 'PIVOT_MB', payload: (ts, n) => ({
    source: 'PIVOT_MB',
    symbol: 'META',
    side: 'LONG',
    entry_price: 580.50,
    stop_price: 575.00,
    timestamp: ts,
    bar_time: `${ts}`,
    trigger: 'BREAK_CLOSE',
    timeframe: '15',
    _nonce: `test-${ts}-${n}`,
  })},
  { name: 'SQUEEZE_PRO ENTRY', payload: (ts, n) => ({
    source: 'SQUEEZE_PRO',
    ticker: 'AMZN',
    direction: 'LONG',
    close: 195.80,
    signal_type: 'ENTRY',
    time: String(ts),
    interval: '15',
    squeeze: { squeeze_released: true },
    levels: { entry: 195.80, swing_stop: 192.50, target_1: 199.00 },
    _nonce: `test-${ts}-${n}`,
  })},
  { name: 'SQUEEZE_PRO EXIT', payload: (ts, n) => ({
    source: 'SQUEEZE_PRO',
    ticker: 'AMZN',
    direction: 'LONG',
    close: 199.20,
    signal_type: 'EXIT',
    time: String(ts),
    interval: '15',
    _nonce: `test-${ts}-${n}`,
  })},
  { name: 'REVERSAL', payload: (ts, n) => ({
    ticker: 'MSFT',
    direction: 'LONG',
    entry: 420.00,
    stop: 415.00,
    target: 430.00,
    timeframe: '15',
    timestamp: ts,
    _nonce: `test-${ts}-${n}`,
  })},
  { name: 'CRT', payload: (ts, n) => ({
    ticker: 'GOOGL',
    direction: 'LONG',
    entry: 175.00,
    stop: 172.00,
    target: 180.00,
    timeframe: '15',
    timestamp: ts,
    _nonce: `test-${ts}-${n}`,
  })},
];

async function main() {
  const ts = Math.floor(Date.now() / 1000);
  console.log(`Sending 10 webhooks to ${BASE_URL}/api/webhooks/tradingview`);
  console.log(`Base timestamp: ${ts}\n`);

  for (let i = 0; i < WEBHOOKS.length; i++) {
    const { name, payload } = WEBHOOKS[i];
    const body = payload(ts + i, i);
    try {
      const res = await post('/api/webhooks/tradingview', body);
      const ok = res.status === 202 || res.status === 200;
      const status = res.body?.status || res.body?.message || res.body?.error || res.status;
      console.log(`${ok ? '✓' : '✗'} ${i + 1}. ${name}: HTTP ${res.status} — ${status}`);
      if (!ok && res.body?.error) console.log(`   Error: ${res.body.error}`);
    } catch (err) {
      console.log(`✗ ${i + 1}. ${name}: ${err.message}`);
    }
    await sleep(300);
  }

  console.log('\nDone. Check Pipeline Observatory and Webhook Inbox.');
}

main().catch(console.error);
