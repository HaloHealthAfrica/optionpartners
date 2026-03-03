#!/usr/bin/env node
'use strict';

/**
 * Direct Unusual Whales API endpoint tester.
 * Tests all 4 endpoints used by UnusualWhalesClient against the live API.
 *
 * Usage:
 *   set UNUSUAL_WHALES_API_KEY=your-key-here
 *   node scripts/test-uw-endpoints.js
 *
 * Or inline:
 *   UNUSUAL_WHALES_API_KEY=your-key node scripts/test-uw-endpoints.js
 */

const API_KEY = process.env.UNUSUAL_WHALES_API_KEY;
const BASE_URL = process.env.UNUSUAL_WHALES_BASE_URL || 'https://api.unusualwhales.com';
const TEST_SYMBOL = process.env.TEST_SYMBOL || 'SPY';

if (!API_KEY) {
  console.error('ERROR: UNUSUAL_WHALES_API_KEY environment variable is required.');
  console.error('');
  console.error('  PowerShell:  $env:UNUSUAL_WHALES_API_KEY="your-key"; node scripts/test-uw-endpoints.js');
  console.error('  Bash:        UNUSUAL_WHALES_API_KEY=your-key node scripts/test-uw-endpoints.js');
  process.exit(1);
}

const ENDPOINTS = [
  {
    name: 'Options Chain',
    method: 'getOptionsChain',
    path: `/api/stock/${TEST_SYMBOL}/option-contracts`,
    description: 'Full options chain with bid/ask/greeks per contract',
    validate: (data) => {
      if (!data?.data) return { ok: false, detail: 'Response missing "data" array' };
      const count = data.data.length;
      if (count === 0) return { ok: false, detail: '"data" array is empty' };
      const sample = data.data[0];
      const fields = ['option_symbol', 'underlying_symbol', 'option_type', 'strike', 'expiry', 'bid', 'ask', 'implied_volatility', 'delta'];
      const missing = fields.filter(f => !(f in sample));
      if (missing.length > 0) return { ok: true, detail: `${count} contracts returned. WARNING: missing fields: ${missing.join(', ')}` };
      return { ok: true, detail: `${count} contracts returned. Sample: ${sample.option_symbol} strike=${sample.strike} bid=${sample.bid} ask=${sample.ask} iv=${sample.implied_volatility}` };
    },
  },
  {
    name: 'Greeks (GEX)',
    method: 'getGEX',
    path: `/api/stock/${TEST_SYMBOL}/greeks`,
    description: 'Per-strike greeks for gamma exposure calculation',
    validate: (data) => {
      if (!data?.data) return { ok: false, detail: 'Response missing "data" array' };
      const count = data.data.length;
      if (count === 0) return { ok: false, detail: '"data" array is empty' };
      const sample = data.data[0];
      const fields = ['strike', 'call_gamma', 'put_gamma', 'call_delta', 'put_delta', 'expiry'];
      const missing = fields.filter(f => !(f in sample));
      if (missing.length > 0) return { ok: true, detail: `${count} rows returned. WARNING: missing fields: ${missing.join(', ')}` };
      return { ok: true, detail: `${count} rows returned. Sample: strike=${sample.strike} call_gamma=${sample.call_gamma} put_gamma=${sample.put_gamma}` };
    },
  },
  {
    name: 'Net Premium Ticks (Flow)',
    method: 'getFlow',
    path: `/api/stock/${TEST_SYMBOL}/net-prem-ticks`,
    description: 'Intraday call/put volume and net premium ticks',
    validate: (data) => {
      if (!data?.data) return { ok: false, detail: 'Response missing "data" array' };
      const count = data.data.length;
      if (count === 0) return { ok: false, detail: '"data" array is empty' };
      const sample = data.data[0];
      const fields = ['call_volume', 'put_volume', 'net_call_premium', 'net_put_premium', 'tape_time'];
      const missing = fields.filter(f => !(f in sample));
      if (missing.length > 0) return { ok: true, detail: `${count} ticks returned. WARNING: missing fields: ${missing.join(', ')}` };
      return { ok: true, detail: `${count} ticks returned. Sample: call_vol=${sample.call_volume} put_vol=${sample.put_volume} net_call_prem=${sample.net_call_premium}` };
    },
  },
  {
    name: 'Interpolated IV',
    method: 'getIV',
    path: `/api/stock/${TEST_SYMBOL}/interpolated-iv`,
    description: 'Interpolated implied volatility at 30/60/90 day tenors',
    validate: (data) => {
      if (!data?.data) return { ok: false, detail: 'Response missing "data" array' };
      const count = data.data.length;
      if (count === 0) return { ok: false, detail: '"data" array is empty' };
      const sample = data.data[0];
      const fields = ['days', 'volatility', 'percentile', 'implied_move_perc'];
      const missing = fields.filter(f => !(f in sample));
      if (missing.length > 0) return { ok: true, detail: `${count} tenors returned. WARNING: missing fields: ${missing.join(', ')}` };
      const tenors = data.data.map(d => d.days).join(', ');
      return { ok: true, detail: `${count} tenors returned (days: ${tenors}). Sample: days=${sample.days} vol=${sample.volatility} pctile=${sample.percentile}` };
    },
  },
];

async function testEndpoint(endpoint) {
  const url = `${BASE_URL}${endpoint.path}`;
  const result = {
    name: endpoint.name,
    method: endpoint.method,
    url,
    description: endpoint.description,
  };

  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    result.latencyMs = Date.now() - start;
    result.httpStatus = response.status;
    result.httpStatusText = response.statusText;

    const contentType = response.headers.get('content-type') || '';
    const rawBody = await response.text();

    if (!response.ok) {
      result.status = 'HTTP_ERROR';
      result.error = `HTTP ${response.status} ${response.statusText}`;
      if (rawBody) {
        try {
          const parsed = JSON.parse(rawBody);
          result.errorBody = parsed;
          result.errorMessage = parsed.message || parsed.error || parsed.detail || rawBody.substring(0, 500);
        } catch {
          result.errorMessage = rawBody.substring(0, 500);
        }
      }
      return result;
    }

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch {
      result.status = 'PARSE_ERROR';
      result.error = 'Response is not valid JSON';
      result.errorMessage = rawBody.substring(0, 500);
      return result;
    }

    const validation = endpoint.validate(data);
    result.status = validation.ok ? 'OK' : 'DATA_ERROR';
    result.detail = validation.detail;
    if (!validation.ok) result.error = validation.detail;

    return result;
  } catch (err) {
    result.latencyMs = Date.now() - start;
    result.status = 'NETWORK_ERROR';
    result.error = err.message;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      result.error = 'Request timed out after 15s';
    }
    return result;
  }
}

function printResult(r) {
  const icon = r.status === 'OK' ? 'PASS' : 'FAIL';
  console.log(`\n  [${icon}] ${r.name}`);
  console.log(`    URL:         ${r.url}`);
  console.log(`    Description: ${r.description}`);
  console.log(`    Status:      ${r.status}`);
  if (r.httpStatus) console.log(`    HTTP:        ${r.httpStatus} ${r.httpStatusText}`);
  if (r.latencyMs != null) console.log(`    Latency:     ${r.latencyMs}ms`);
  if (r.detail) console.log(`    Detail:      ${r.detail}`);
  if (r.error && r.status !== 'OK') {
    console.log(`    Error:       ${r.error}`);
  }
  if (r.errorMessage) console.log(`    Message:     ${r.errorMessage}`);
  if (r.errorBody) console.log(`    Raw Error:   ${JSON.stringify(r.errorBody, null, 2).split('\n').map(l => '                 ' + l).join('\n').trim()}`);
}

async function main() {
  console.log('='.repeat(80));
  console.log('UNUSUAL WHALES API ENDPOINT VALIDATION');
  console.log('='.repeat(80));
  console.log(`  Base URL:    ${BASE_URL}`);
  console.log(`  API Key:     ${API_KEY.substring(0, 8)}...${API_KEY.substring(API_KEY.length - 4)}`);
  console.log(`  Test Symbol: ${TEST_SYMBOL}`);
  console.log(`  Timestamp:   ${new Date().toISOString()}`);
  console.log(`  Node:        ${process.version}`);

  const results = [];
  for (const ep of ENDPOINTS) {
    const r = await testEndpoint(ep);
    results.push(r);
    printResult(r);
  }

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));

  const passed = results.filter(r => r.status === 'OK');
  const failed = results.filter(r => r.status !== 'OK');

  console.log(`  Total:  ${results.length}`);
  console.log(`  Passed: ${passed.length}`);
  console.log(`  Failed: ${failed.length}`);
  console.log('');

  for (const r of results) {
    const icon = r.status === 'OK' ? 'PASS' : 'FAIL';
    const msg = r.status === 'OK' ? r.detail : `${r.status}: ${r.error}`;
    console.log(`  [${icon}] ${r.name.padEnd(25)} ${msg}`);
  }

  if (failed.length > 0) {
    console.log('\n' + '='.repeat(80));
    console.log('SUPPORT TICKET DETAILS');
    console.log('='.repeat(80));
    console.log('');
    console.log('The following Unusual Whales API endpoints returned errors:');
    console.log('');
    for (const r of failed) {
      console.log(`Endpoint: ${r.url}`);
      console.log(`HTTP Status: ${r.httpStatus || 'N/A'}`);
      console.log(`Error Type: ${r.status}`);
      console.log(`Error: ${r.error}`);
      if (r.errorMessage) console.log(`Message: ${r.errorMessage}`);
      console.log('---');
    }
    console.log('');
    console.log('Account API Key (first 8 chars):', API_KEY.substring(0, 8) + '...');
    console.log('Tested at:', new Date().toISOString());
    console.log('');
  }

  console.log('');
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(2);
});
