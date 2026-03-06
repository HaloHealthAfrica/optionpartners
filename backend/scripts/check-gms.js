#!/usr/bin/env node
'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
(async () => {
  const r = await pool.query(`
    SELECT symbol, last_price, price_updated_at, chain_ok, chain_contracts_count,
           chain_updated_at, bid_ask_spread_pct, price_fetch_failures, chain_fetch_failures,
           last_price_error, last_chain_error
    FROM global_market_state
    ORDER BY symbol
  `);
  console.log('GLOBAL MARKET STATE:');
  const now = Date.now();
  r.rows.forEach(s => {
    const priceAge = s.price_updated_at ? Math.round((now - new Date(s.price_updated_at).getTime()) / 1000) : null;
    const chainAge = s.chain_updated_at ? Math.round((now - new Date(s.chain_updated_at).getTime()) / 1000) : null;
    console.log(`  ${s.symbol}:`);
    console.log(`    price=$${s.last_price} age=${priceAge}s failures=${s.price_fetch_failures} err=${s.last_price_error || 'none'}`);
    console.log(`    chain_ok=${s.chain_ok} contracts=${s.chain_contracts_count} age=${chainAge}s spread=${s.bid_ask_spread_pct} failures=${s.chain_fetch_failures} err=${s.last_chain_error || 'none'}`);
  });

  // Check symbol_state for IWN
  const iwn = await pool.query(`
    SELECT symbol, chain_ok, chain_updated_at, price_updated_at, last_price, regime
    FROM symbol_state
    WHERE symbol = 'IWN'
    LIMIT 5
  `);
  console.log('\nSYMBOL STATE for IWN:');
  iwn.rows.forEach(s => {
    const chainAge = s.chain_updated_at ? Math.round((now - new Date(s.chain_updated_at).getTime()) / 1000) : null;
    console.log(`  chain_ok=${s.chain_ok} chain_age=${chainAge}s price=$${s.last_price} regime=${s.regime}`);
  });

  await pool.end();
})();
