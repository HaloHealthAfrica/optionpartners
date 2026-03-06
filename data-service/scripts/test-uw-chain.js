#!/usr/bin/env node
'use strict';
const https = require('https');

const API_KEY = process.env.UNUSUAL_WHALES_API_KEY;
if (!API_KEY) { console.error('UNUSUAL_WHALES_API_KEY not set'); process.exit(1); }

const symbol = process.argv[2] || 'SPY';

const options = {
  hostname: 'api.unusualwhales.com',
  path: `/api/stock/${symbol}/option-contracts`,
  method: 'GET',
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    Accept: 'application/json',
  },
};

console.log(`Testing UW API: GET /api/stock/${symbol}/option-contracts`);
console.log(`API key: ${API_KEY.slice(0, 8)}...`);

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Headers: ${JSON.stringify(res.headers, null, 2)}`);
    if (res.statusCode === 200) {
      try {
        const parsed = JSON.parse(body);
        const count = parsed.data ? parsed.data.length : 'N/A';
        console.log(`Contracts returned: ${count}`);
        if (parsed.data && parsed.data[0]) {
          console.log('First contract:', JSON.stringify(parsed.data[0], null, 2));
        }
      } catch (e) {
        console.log('Body (first 500 chars):', body.slice(0, 500));
      }
    } else {
      console.log('Error body:', body.slice(0, 500));
    }
  });
});

req.on('error', (e) => { console.error('Request error:', e.message); });
req.end();
