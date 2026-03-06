/*
 * Production Webhook Audit Helper (safe, non-destructive by default)
 *
 * Usage (run on a production host where your secrets/keys are present):
 *
 *   # REQUIRED: explicit confirmation to avoid accidental runs
 *   setx PRODUCTION_AUDIT_CONFIRM true
 *   # Provide auth: either JWT or API key (one of these required)
 *   setx AUDIT_AUTH_TOKEN "<your-jwt-or-api-key>"
 *   # Optional: base URL of the production backend (defaults to http://localhost:3000)
 *   setx AUDIT_BASE_URL "https://api.yourdomain.com"
 *
 * Then run:
 *   node backend/scripts/prod-webhook-audit.js
 *
 * By default the script is read-only and performs:
 *  - verifies explicit confirmation env var (PRODUCTION_AUDIT_CONFIRM)
 *  - GET /api/webhooks/stats (requires auth)
 *  - GET /api/webhooks (recent events)
 *  - POST a TEST PING to /api/webhooks/tradingview (payload { test: true }) to verify ingestion
 *
 * To run a more intrusive end-to-end simulation (MAY create sim orders/trades), set
 * the env var RUN_FULL=true. This is intentionally gated and will require
 * PRODUCTION_AUDIT_CONFIRM=true and AUDIT_ALLOW_FULL=true both present.
 *
 * IMPORTANT: I cannot run this script myself against your production system.
 * You must run it in your production environment where keys are present. The
 * script never logs secrets; it only shows summarized responses and counts.
 */

const http = require('http');
const https = require('https');
const url = require('url');

const BASE_URL = process.env.AUDIT_BASE_URL || 'http://localhost:3000';
const AUTH = process.env.AUDIT_AUTH_TOKEN || process.env.AUDIT_API_KEY || null;
const CONFIRM = String(process.env.PRODUCTION_AUDIT_CONFIRM || '').toLowerCase() === 'true';
const RUN_FULL = String(process.env.RUN_FULL || '').toLowerCase() === 'true';
const ALLOW_FULL = String(process.env.AUDIT_ALLOW_FULL || '').toLowerCase() === 'true';

if (!CONFIRM) {
  console.error('\nERROR: PRODUCTION_AUDIT_CONFIRM must be set to true to run this script.');
  console.error('This is a safety check to prevent accidental production activity.');
  process.exit(2);
}

if (!AUTH) {
  console.error('\nERROR: No authentication token provided. Set AUDIT_AUTH_TOKEN (JWT or API key) or AUDIT_API_KEY.');
  process.exit(2);
}

if (RUN_FULL && !ALLOW_FULL) {
  console.error('\nERROR: RUN_FULL requested but AUDIT_ALLOW_FULL is not true. To run intrusive tests, set both RUN_FULL=true and AUDIT_ALLOW_FULL=true.');
  process.exit(2);
}

function apiRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(BASE_URL + path);
    const isHttps = parsed.protocol === 'https:';
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'prod-webhook-audit/1.0',
        'Accept': 'application/json',
      },
    };

    // Support either Bearer token or API key header (x-api-key)
    if (/^Bearer\s+/i.test(AUTH)) {
      opts.headers['Authorization'] = AUTH;
    } else if (AUTH.length > 40 || AUTH.includes('.')) {
      // heuristics: long token or contains a dot -> Bearer
      opts.headers['Authorization'] = `Bearer ${AUTH}`;
    } else {
      opts.headers['x-api-key'] = AUTH;
    }

    const req = (isHttps ? https : http).request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsedBody = null;
        try { parsedBody = data ? JSON.parse(data) : null; } catch (e) { parsedBody = data; }
        resolve({ status: res.statusCode, body: parsedBody });
      });
    });
    req.on('error', reject);

    if (body) {
      const s = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(s);
    }
    req.end();
  });
}

(async function main() {
  console.log('\n=== Production Webhook Audit (safe mode) ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log('Note: this script requires you run it where production keys are present.');

  try {
    console.log('\n1) Fetching webhook stats (GET /api/webhooks/stats)');
    const stats = await apiRequest('/api/webhooks/stats');
    console.log(`  HTTP ${stats.status}`);
    if (stats.status === 200) {
      console.log('  Stats:', stats.body);
    } else {
      console.log('  Body:', stats.body);
    }

    console.log('\n2) Fetching recent webhook events (GET /api/webhooks?page=1&limit=25)');
    const list = await apiRequest('/api/webhooks?page=1&limit=25');
    console.log(`  HTTP ${list.status}`);
    if (list.status === 200) {
      const events = list.body.events || list.body || [];
      console.log(`  Recent events: ${events.length}`);
      for (const e of events.slice(0, 10)) {
        console.log(`   - id=${e.id} status=${e.status} source=${e.indicator_source || e.source} received_at=${e.received_at} error=${e.error_message ? '[ERR]' : '-'} `);
      }
    } else {
      console.log('  Body:', list.body);
    }

    console.log('\n3) Sending a TEST PING webhook (POST /api/webhooks/tradingview with { test: true })');
    const pingResp = await apiRequest('/api/webhooks/tradingview', 'POST', { test: true });
    console.log(`  HTTP ${pingResp.status}`);
    console.log('  Response:', pingResp.body && typeof pingResp.body === 'object' ? { message: pingResp.body.message, eventId: pingResp.body.eventId, status: pingResp.body.status } : pingResp.body);

    console.log('\n4) Optional: run intrusive end-to-end tests (create simulated orders/trades)');
    if (!RUN_FULL) {
      console.log('  RUN_FULL is not enabled; skipping intrusive tests. To enable, set RUN_FULL=true and AUDIT_ALLOW_FULL=true in environment and re-run.');
    } else {
      console.log('  RUN_FULL enabled — performing a small set of representative webhooks that may create sim orders/trades.\n  WARNING: This can create records in production DB. Proceed only if you understand the impact.');

      const sampleSignals = [
        { ticker: 'SPY', indicator: 'ORB', action: 'buy', direction: 'long', price: 570.5, time: Math.floor(Date.now()/1000) },
        { ticker: 'AAPL', action: 'buy', contract_type: 'STOCK', price: 185.0, quantity: 1, time: Math.floor(Date.now()/1000)+1 },
      ];

      for (const s of sampleSignals) {
        console.log(`\n  Sending sample webhook: ${JSON.stringify(s)}`);
        const resp = await apiRequest('/api/webhooks/tradingview', 'POST', s);
        console.log(`   -> HTTP ${resp.status} bodySummary:`, resp.body && typeof resp.body === 'object' ? { message: resp.body.message, eventId: resp.body.eventId, status: resp.body.status, reason: resp.body.reason } : resp.body);
      }

      console.log('\n  Waiting 15s for processor to pick up events...');
      await new Promise(r => setTimeout(r, 15000));

      console.log('\n  Fetching latest sim orders (GET /api/sim/orders?limit=10)');
      const orders = await apiRequest('/api/sim/orders?limit=10');
      console.log(`   -> HTTP ${orders.status}`);
      console.log('   -> Body summary:', Array.isArray(orders.body) ? orders.body.map(o => ({ id: o.id, symbol: o.symbol, status: o.status })) : orders.body);
    }

    console.log('\nAudit complete. Review the outputs above.');
  } catch (err) {
    console.error('\nFATAL: Audit failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
