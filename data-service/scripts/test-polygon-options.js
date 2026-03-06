#!/usr/bin/env node
'use strict';
const https = require('https');

const key = process.env.POLYGON_API_KEY;
if (!key) { console.error('POLYGON_API_KEY not set'); process.exit(1); }

const symbol = process.argv[2] || 'SPY';
const path = `/v3/snapshot/options/${symbol}?limit=5&apiKey=${key}`;

console.log(`Testing Polygon options: GET ${path.replace(key, key.slice(0,6)+'...')}`);

https.get({ hostname: 'api.polygon.io', path, headers: { Accept: 'application/json' } }, (res) => {
  let body = '';
  res.on('data', (c) => { body += c; });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const j = JSON.parse(body);
      if (j.results && j.results.length > 0) {
        console.log('Results count:', j.results.length);
        const c = j.results[0];
        console.log('Sample contract:', JSON.stringify({
          ticker: c.details?.ticker,
          type: c.details?.contract_type,
          strike: c.details?.strike_price,
          expiry: c.details?.expiration_date,
          iv: c.implied_volatility,
          delta: c.greeks?.delta,
          gamma: c.greeks?.gamma,
          theta: c.greeks?.theta,
          vega: c.greeks?.vega,
          bid: c.last_quote?.bid,
          ask: c.last_quote?.ask,
          oi: c.open_interest,
          volume: c.day?.volume,
        }, null, 2));
      } else {
        console.log('Response:', body.slice(0, 500));
      }
    } catch (e) {
      console.log('Raw body:', body.slice(0, 500));
    }
  });
});
