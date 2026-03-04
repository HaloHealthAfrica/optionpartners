'use strict';

/**
 * Market Data Tenancy Validation Script
 * 
 * Validates that:
 * 1. TwelveData and UnusualWhales APIs are reachable and returning data
 * 2. Each user_id receives correct symbol_state updates (no cross-user leakage)
 * 3. Global market state is populated and fresh
 * 
 * Usage:
 *   node scripts/validate-marketdata-tenancy.js
 *   node scripts/validate-marketdata-tenancy.js --user f5b1c75e
 *   node scripts/validate-marketdata-tenancy.js --symbols SPY,AAPL,IWM
 */

require('dotenv').config();
const db = require('../src/config/database');
const dataServiceProxy = require('../src/services/dataServiceProxy');

const ALL_USERS = [
  { id: 'f5b1c75e-5dab-44ea-bbc4-8a4c103f0b4b', label: 'main' },
  { id: '3c62d4b9-d780-4fba-94e9-3d6b5f2f5c1a', label: 'secondary' },
  { id: '6ea304b2-2b3f-4c1e-9f5a-8d7c6e4b3a2f', label: 'test' },
];

const DEFAULT_SYMBOLS = ['SPY', 'AAPL', 'IWM'];

async function validateProvider(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    const latencyMs = Date.now() - start;
    return { provider: name, success: true, latencyMs, data: result };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return { provider: name, success: false, latencyMs, error: err.message };
  }
}

async function validateSymbol(symbol) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Validating: ${symbol}`);
  console.log(`${'='.repeat(60)}`);

  // 1. Price fetch (TwelveData via data-service)
  const priceResult = await validateProvider('TwelveData/Quote', async () => {
    const quote = await dataServiceProxy.getQuote(symbol);
    const price = quote?.data?.price ?? quote?.data?.last ?? quote?.data?.close;
    return { price: parseFloat(price), raw: quote?.data };
  });

  if (priceResult.success) {
    console.log(`  ✓ Price: $${priceResult.data.price} (${priceResult.latencyMs}ms)`);
  } else {
    console.log(`  ✗ Price FAILED: ${priceResult.error} (${priceResult.latencyMs}ms)`);
  }

  // 2. Options chain fetch (UnusualWhales via data-service)
  const chainResult = await validateProvider('UnusualWhales/Chain', async () => {
    const chain = await dataServiceProxy.getOptionsChain(symbol);
    const contracts = chain?.data?.contracts || [];
    const expirations = new Set(contracts.map(c => c.expiration || c.expiry));
    const nearestExpiry = [...expirations].sort()[0];
    const nearExpContracts = contracts.filter(c => (c.expiration || c.expiry) === nearestExpiry);
    const sample = nearExpContracts[0];

    return {
      totalContracts: contracts.length,
      expirationCount: expirations.size,
      nearestExpiry,
      strikesAtNearest: nearExpContracts.length,
      sampleContract: sample ? {
        strike: sample.strike, type: sample.type,
        bid: sample.bid, ask: sample.ask, mid: sample.mid,
        iv: sample.iv || sample.impliedVolatility,
        oi: sample.openInterest || sample.oi,
        volume: sample.volume || sample.vol,
      } : null,
    };
  });

  if (chainResult.success) {
    const d = chainResult.data;
    console.log(`  ✓ Chain: ${d.totalContracts} contracts, ${d.expirationCount} expirations (${chainResult.latencyMs}ms)`);
    console.log(`    Nearest: ${d.nearestExpiry} (${d.strikesAtNearest} strikes)`);
    if (d.sampleContract) {
      const s = d.sampleContract;
      console.log(`    Sample: ${s.type} ${s.strike} — bid=$${s.bid} ask=$${s.ask} mid=$${s.mid} iv=${s.iv} oi=${s.oi}`);
    }
  } else {
    console.log(`  ✗ Chain FAILED: ${chainResult.error} (${chainResult.latencyMs}ms)`);
  }

  // 3. IV fetch
  const ivResult = await validateProvider('IV', async () => {
    const iv = await dataServiceProxy.getIV(symbol);
    return iv?.data;
  });
  if (ivResult.success) {
    console.log(`  ✓ IV: rank=${ivResult.data?.ivRank?.toFixed(2)} pctl=${ivResult.data?.ivPercentile?.toFixed(2)} (${ivResult.latencyMs}ms)`);
  } else {
    console.log(`  ✗ IV FAILED: ${ivResult.error} (${ivResult.latencyMs}ms)`);
  }

  return { symbol, price: priceResult, chain: chainResult, iv: ivResult };
}

async function validateUserState(userId, label, symbols) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  User: ${label} (${userId})`);
  console.log(`${'─'.repeat(60)}`);

  for (const symbol of symbols) {
    const result = await db.query(
      `SELECT symbol, last_price, price_updated_at, chain_ok, chain_updated_at,
              macro_bias, regime, local_bias, updated_at
       FROM symbol_state WHERE user_id = $1 AND symbol = $2`,
      [userId, symbol]
    );

    if (result.rows.length === 0) {
      console.log(`  [${symbol}] No symbol_state row`);
      continue;
    }

    const row = result.rows[0];
    const priceAge = row.price_updated_at
      ? `${((Date.now() - new Date(row.price_updated_at).getTime()) / 60000).toFixed(1)}min`
      : 'never';
    const chainAge = row.chain_updated_at
      ? `${((Date.now() - new Date(row.chain_updated_at).getTime()) / 60000).toFixed(1)}min`
      : 'never';

    console.log(`  [${symbol}] price=$${row.last_price || 'null'} (${priceAge}) chain=${row.chain_ok ? 'OK' : 'NONE'} (${chainAge}) macro=${row.macro_bias} regime=${row.regime}`);
  }
}

async function validateGlobalState(symbols) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Global Market State`);
  console.log(`${'─'.repeat(60)}`);

  for (const symbol of symbols) {
    const result = await db.query(
      `SELECT * FROM global_market_state WHERE symbol = $1`,
      [symbol]
    );

    if (result.rows.length === 0) {
      console.log(`  [${symbol}] No global_market_state row`);
      continue;
    }

    const row = result.rows[0];
    const priceAge = row.price_updated_at
      ? `${((Date.now() - new Date(row.price_updated_at).getTime()) / 60000).toFixed(1)}min`
      : 'never';
    const chainAge = row.chain_updated_at
      ? `${((Date.now() - new Date(row.chain_updated_at).getTime()) / 60000).toFixed(1)}min`
      : 'never';

    console.log(`  [${symbol}] price=$${row.last_price || 'null'} (${priceAge}) chain=${row.chain_ok ? 'OK' : 'NONE'} (${chainAge}) contracts=${row.chain_contracts_count || 0} liq=${row.liquidity_ok ? 'OK' : 'NO'}`);
    if (row.last_price_error) console.log(`    ⚠ Price error: ${row.last_price_error}`);
    if (row.last_chain_error) console.log(`    ⚠ Chain error: ${row.last_chain_error}`);
  }
}

async function validateCrossUserLeakage(symbols) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Cross-User Leakage Check`);
  console.log(`${'─'.repeat(60)}`);

  for (const symbol of symbols) {
    const result = await db.query(
      `SELECT user_id, chain_updated_at, chain_ok, chain_open_interest
       FROM symbol_state WHERE symbol = $1
       ORDER BY user_id`,
      [symbol]
    );

    if (result.rows.length <= 1) {
      console.log(`  [${symbol}] Only ${result.rows.length} user(s) have state — cannot check leakage`);
      continue;
    }

    const chainTimes = result.rows
      .filter(r => r.chain_updated_at)
      .map(r => new Date(r.chain_updated_at).getTime());

    if (chainTimes.length < 2) {
      console.log(`  [${symbol}] ⚠ Chain data present for ${chainTimes.length}/${result.rows.length} users — possible routing issue`);
    } else {
      const maxDrift = Math.max(...chainTimes) - Math.min(...chainTimes);
      const driftSec = maxDrift / 1000;
      if (driftSec > 600) {
        console.log(`  [${symbol}] ⚠ Chain timestamp drift: ${driftSec.toFixed(0)}s between users — likely routing bug`);
      } else {
        console.log(`  [${symbol}] ✓ Chain data consistent across ${result.rows.length} users (drift: ${driftSec.toFixed(0)}s)`);
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const userFilter = args.includes('--user') ? args[args.indexOf('--user') + 1] : null;
  const symbolArg = args.includes('--symbols') ? args[args.indexOf('--symbols') + 1] : null;
  const symbols = symbolArg ? symbolArg.split(',').map(s => s.trim().toUpperCase()) : DEFAULT_SYMBOLS;

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       Market Data Tenancy Validation                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`Symbols: ${symbols.join(', ')}`);
  console.log(`Time: ${new Date().toISOString()}`);

  // 1. Validate data-service providers
  console.log('\n\n══ PROVIDER VALIDATION ══');
  const providerResults = [];
  for (const symbol of symbols) {
    providerResults.push(await validateSymbol(symbol));
  }

  // 2. Validate data-service health
  console.log('\n\n══ DATA SERVICE HEALTH ══');
  try {
    const health = await dataServiceProxy.getHealth();
    console.log(`  Status: ${health.status}`);
    console.log(`  Ready: ${health.ready}`);
    console.log(`  Providers: ${JSON.stringify(health.configuration || {})}`);
    if (health.feeds) {
      console.log(`  Price feed: fresh=${health.feeds.price?.fresh} failures=${health.feeds.price?.failures}`);
      console.log(`  Chain feed: fresh=${health.feeds.chain?.fresh} failures=${health.feeds.chain?.failures}`);
    }
  } catch (err) {
    console.log(`  ✗ Health check FAILED: ${err.message}`);
  }

  // 3. Validate per-user symbol_state
  console.log('\n\n══ PER-USER SYMBOL STATE ══');
  const users = userFilter
    ? ALL_USERS.filter(u => u.id.startsWith(userFilter))
    : ALL_USERS;

  for (const user of users) {
    await validateUserState(user.id, user.label, symbols);
  }

  // 4. Validate global market state
  console.log('\n\n══ GLOBAL MARKET STATE ══');
  try {
    await validateGlobalState(symbols);
  } catch (err) {
    console.log(`  (global_market_state table may not exist yet: ${err.message})`);
  }

  // 5. Cross-user leakage check
  console.log('\n\n══ CROSS-USER LEAKAGE CHECK ══');
  await validateCrossUserLeakage(symbols);

  // 6. Summary
  console.log('\n\n══ SUMMARY ══');
  let allOk = true;
  for (const r of providerResults) {
    const priceOk = r.price.success;
    const chainOk = r.chain.success;
    console.log(`  ${r.symbol}: Price=${priceOk ? '✓' : '✗'} Chain=${chainOk ? '✓' : '✗'}`);
    if (!priceOk || !chainOk) allOk = false;
  }

  console.log(`\n  Overall: ${allOk ? '✓ ALL PROVIDERS OPERATIONAL' : '✗ SOME PROVIDERS FAILED'}`);

  await db.end();
  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error('Validation failed:', err);
  process.exit(1);
});
