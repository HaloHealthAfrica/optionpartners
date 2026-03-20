#!/usr/bin/env node
'use strict';

/**
 * E2E All Systems Test
 * Confirms backend, database, webhook ingestion, and (optionally) frontend are functional.
 * Works against local (http) or production (https).
 *
 * Usage:
 *   node backend/scripts/e2e-all-systems.js
 *   E2E_BASE_URL=http://localhost:3000 node backend/scripts/e2e-all-systems.js
 *   E2E_BASE_URL=https://optionpartners.fly.dev node backend/scripts/e2e-all-systems.js
 *
 * Default: http://localhost:8080 (docker) or http://localhost:3000 (local backend)
 */

const http = require('http');
const https = require('https');

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8080';
const isHttps = BASE_URL.startsWith('https');
const client = isHttps ? https : http;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(path, BASE_URL);
    const req = client.request(url, {
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

function get(path, parseJson = true) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    client.get(url, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        if (parseJson) {
          try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
          catch { resolve({ status: res.statusCode, body: chunks }); }
        } else {
          resolve({ status: res.statusCode, body: chunks });
        }
      });
    }).on('error', reject);
  });
}

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
  console.log('  E2E ALL SYSTEMS TEST');
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Time:   ${new Date().toISOString()}`);
  console.log('═'.repeat(72));

  // ─────────────────────────────────────────────────────────
  //  1. BACKEND HEALTH
  // ─────────────────────────────────────────────────────────
  console.log('\n── 1. Backend Health ──');
  let health;
  try {
    health = await get('/api/health');
  } catch (err) {
    check('Backend reachable', false, err.message);
    console.log('\n  Cannot reach backend. Is it running?');
    console.log('  - Docker: docker-compose up -d');
    console.log('  - Local:  cd backend && npm run dev');
    console.log('  - Override: E2E_BASE_URL=http://localhost:3000 node backend/scripts/e2e-all-systems.js');
    process.exit(1);
  }

  check('Health endpoint responds (200)', health.status === 200, `HTTP ${health.status}`);
  check('Status is OK/healthy', ['healthy', 'OK'].includes(health.body?.status), health.body?.status);
  check('Database connected', ['connected', 'OK'].includes(health.body?.services?.database), health.body?.services?.database);
  check('Background worker running', health.body?.services?.backgroundWorker?.isRunning === true, health.body?.services?.backgroundWorker?.status);
  console.log(`     Worker: ${JSON.stringify(health.body?.services?.backgroundWorker || {})}`);

  // ─────────────────────────────────────────────────────────
  //  2. WEBHOOK PING (no auth)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 2. Webhook Ping ──');
  const ping = await post('/api/webhooks/tradingview', { test: true, type: 'PING' });
  check('Ping accepted (200)', ping.status === 200, `HTTP ${ping.status}`);
  check('Ping status TEST_PING', ping.body?.status === 'TEST_PING', ping.body?.status);
  check('Ping returns eventId', !!ping.body?.eventId, ping.body?.eventId);

  // ─────────────────────────────────────────────────────────
  //  3. SIGNALS WEBHOOK (trade-trigger)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 3. SIGNALS Webhook (trade-trigger) ──');
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
  //  4. FRONTEND (if served from same origin)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 4. Frontend ──');
  const frontend = await get('/', false);
  const hasHtml = typeof frontend.body === 'string' &&
    (frontend.body.includes('<!DOCTYPE') || frontend.body.includes('<html') || frontend.body.includes('<div id="app"'));
  check('Frontend serves HTML (200)', frontend.status === 200 && hasHtml, frontend.status === 200 ? 'no HTML in response' : `HTTP ${frontend.status}`);

  // ─────────────────────────────────────────────────────────
  //  5. API DOCS (Swagger)
  // ─────────────────────────────────────────────────────────
  console.log('\n── 5. API Docs ──');
  const swagger = await get('/api-docs/');
  check('Swagger docs reachable', swagger.status === 200 || swagger.status === 301 || swagger.status === 302, `HTTP ${swagger.status}`);

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
  console.error('E2E runner error:', err);
  process.exit(1);
});
