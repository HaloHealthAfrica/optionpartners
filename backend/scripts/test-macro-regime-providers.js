#!/usr/bin/env node
'use strict';

/**
 * Test script: verify we can fetch regime/macro data from data-service providers.
 * Run from backend: node scripts/test-macro-regime-providers.js
 *
 * Env (or .env):
 *   DATA_SERVICE_URL     - default http://localhost:4000
 *   DATA_SERVICE_API_KEY - required for /regime, /vix, /macro
 *
 * Deployed test:
 *   $env:DATA_SERVICE_URL = "https://optionpartners-data.fly.dev"
 *   node scripts/test-macro-regime-providers.js
 */

require('dotenv').config();

const axios = require('axios');

const DATA_SERVICE_URL = process.env.DATA_SERVICE_URL || 'http://localhost:4000';
const DATA_SERVICE_API_KEY = process.env.DATA_SERVICE_API_KEY || 'dev-key';

const client = axios.create({
  baseURL: DATA_SERVICE_URL.replace(/\/$/, '') + '/api',
  timeout: 15000,
  headers: {
    'x-api-key': DATA_SERVICE_API_KEY,
    'Content-Type': 'application/json',
  },
});

async function testEndpoint(name, path) {
  try {
    const res = await client.get(path);
    return { ok: true, data: res.data };
  } catch (err) {
    return {
      ok: false,
      error: err.response?.data?.error || err.message,
      status: err.response?.status,
    };
  }
}

async function main() {
  console.log('=== Macro/Regime Provider Test ===\n');
  console.log(`Data service: ${DATA_SERVICE_URL}`);
  console.log(`API key: ${DATA_SERVICE_API_KEY ? '***' + DATA_SERVICE_API_KEY.slice(-4) : 'NOT SET'}\n`);

  // 1. Health check
  const health = await testEndpoint('health', '/health');
  if (!health.ok) {
    console.log('❌ Health check failed:', health.error);
    console.log('   Ensure data-service is running and reachable.');
    process.exit(1);
  }
  console.log('✅ Health: OK\n');

  // 2. Regime (VIX + macro → tradingBias)
  const regime = await testEndpoint('regime', '/regime');
  if (regime.ok) {
    const r = regime.data?.data ?? regime.data;
    console.log('✅ Regime (VIX + macro → tradingBias):');
    console.log('   tradingBias:', r?.tradingBias ?? 'N/A');
    console.log('   regime:', r?.regime ?? 'N/A');
    console.log('   vixLevel:', r?.vixLevel ?? 'N/A');
    console.log('   vixTrend:', r?.vixTrend ?? 'N/A');
    console.log('   termStructure:', r?.termStructure ?? 'N/A');
    console.log('   timestamp:', r?.timestamp ? new Date(r.timestamp).toISOString() : 'N/A');
  } else {
    console.log('❌ Regime failed:', regime.error, regime.status ? `(${regime.status})` : '');
  }
  console.log('');

  // 3. VIX (CBOE)
  const vix = await testEndpoint('vix', '/vix');
  if (vix.ok) {
    const v = vix.data?.data ?? vix.data;
    console.log('✅ VIX (CBOE):');
    console.log('   spot:', v?.spot ?? 'N/A');
    console.log('   termStructure:', v?.termStructure ?? 'N/A');
    console.log('   provider:', vix.data?.provider ?? 'N/A');
  } else {
    console.log('❌ VIX failed:', vix.error, vix.status ? `(${vix.status})` : '');
  }
  console.log('');

  // 4. Macro (FRED)
  const macro = await testEndpoint('macro', '/macro');
  if (macro.ok) {
    const m = macro.data?.data ?? macro.data;
    console.log('✅ Macro (FRED):');
    console.log('   fedFundsRate:', m?.fedFundsRate ?? 'N/A');
    console.log('   yield2y:', m?.yield2y ?? 'N/A');
    console.log('   yield10y:', m?.yield10y ?? 'N/A');
    console.log('   yieldSpread:', m?.yieldSpread ?? 'N/A');
    console.log('   yieldCurveInverted:', m?.yieldCurveInverted ?? 'N/A');
    console.log('   daysUntilFomc:', m?.daysUntilFomc ?? 'N/A');
  } else {
    console.log('❌ Macro failed:', macro.error, macro.status ? `(${macro.status})` : '');
  }

  // Summary for macro backfill
  const regimeOk = regime.ok && (regime.data?.data ?? regime.data)?.tradingBias;
  const macroOk = macro.ok;
  console.log('\n--- Macro Backfill Readiness ---');
  if (regimeOk) {
    console.log('✅ Regime has tradingBias — macro backfill will use VIX+macro for bias');
  } else if (macroOk) {
    console.log('⚠️  Regime failed (e.g. CBOE circuit breaker) but Macro (FRED) works');
    console.log('   Backfill currently requires tradingBias — consider resetting data-service circuit breaker:');
    console.log('   curl -X POST -H "X-API-Key: $API_KEY" https://optionpartners-data.fly.dev/api/admin/circuit-breaker/reset');
  } else {
    console.log('❌ Both regime and macro failed — macro backfill will not work');
  }
}

main().catch((err) => {
  console.error('Script error:', err.message);
  process.exit(1);
});
