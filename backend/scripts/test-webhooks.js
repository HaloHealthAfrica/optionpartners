require('dotenv').config();
const http = require('http');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');

const USER_ID = 'f5b1c75e-fa75-4f81-90fa-c0d9085f8c04';
const TOKEN = jwt.sign(
  { id: USER_ID, email: 'edwin@example.com', username: 'edwin', role: 'admin' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);

function sendWebhook(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/webhooks/tradingview',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${TOKEN}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('='.repeat(70));
  console.log('OPTIONS CONSTRUCTOR WEBHOOK TESTS');
  console.log('='.repeat(70));

  const tests = [
    {
      name: '1. BARE SIGNAL (ORB long) -> should construct CALL',
      payload: {
        ticker: 'SPY',
        indicator: 'ORB',
        action: 'buy',
        direction: 'long',
        price: 570.50,
        time: Math.floor(Date.now() / 1000),
      },
    },
    {
      name: '2. BARE SIGNAL (ORB short) -> should construct PUT',
      payload: {
        ticker: 'SPY',
        indicator: 'ORB',
        action: 'sell',
        direction: 'short',
        price: 570.50,
        time: Math.floor(Date.now() / 1000) + 1,
      },
    },
    {
      name: '3. EXPLICIT OPTIONS (full strike/exp) -> should bypass constructor',
      payload: {
        ticker: 'SPY',
        action: 'buy',
        contract_type: 'CALL',
        strike: 570,
        expiration: '2026-03-06',
        price: 4.00,
        quantity: 1,
        time: Math.floor(Date.now() / 1000) + 2,
      },
    },
    {
      name: '4. STOCK TRADE -> should bypass constructor',
      payload: {
        ticker: 'AAPL',
        action: 'buy',
        contract_type: 'STOCK',
        price: 185.00,
        quantity: 10,
        time: Math.floor(Date.now() / 1000) + 3,
      },
    },
  ];

  for (const test of tests) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`TEST: ${test.name}`);
    console.log(`Payload: ${JSON.stringify(test.payload)}`);
    
    try {
      const result = await sendWebhook(test.payload);
      console.log(`Response: HTTP ${result.status} -> ${JSON.stringify(result.body)}`);
      
      if (result.body.eventId) {
        console.log(`Event ID: ${result.body.eventId}`);
      }
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('Waiting 15s for processor to pick up events...');
  await sleep(15000);

  console.log('\n=== WEBHOOK EVENT RESULTS ===');
  const events = await db.query(
    'SELECT id, status, error_message, received_at FROM webhook_events WHERE user_id = $1 ORDER BY received_at DESC LIMIT 10',
    [USER_ID]
  );
  console.table(events.rows);

  console.log('\n=== SIGNAL REJECTIONS ===');
  const rejections = await db.query(
    'SELECT signal_data, guard_name, reason, created_at FROM signal_rejections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
    [USER_ID]
  );
  if (rejections.rows.length > 0) {
    for (const r of rejections.rows) {
      console.log(`  [${r.guard_name}] ${r.reason}`);
    }
  } else {
    console.log('  (none)');
  }

  console.log('\n=== SIM POSITIONS ===');
  const positions = await db.query(
    'SELECT id, symbol, side, contract_type, strike, expiration, quantity, status, entry_price FROM sim_positions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
    [USER_ID]
  );
  if (positions.rows.length > 0) {
    console.table(positions.rows);
  } else {
    console.log('  (none)');
  }

  console.log('\n=== SIM ORDERS ===');
  const orders = await db.query(
    'SELECT id, symbol, side, order_type, status, rejection_reason FROM sim_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
    [USER_ID]
  );
  if (orders.rows.length > 0) {
    console.table(orders.rows);
  } else {
    console.log('  (none)');
  }

  await db.pool.end();
  console.log('\nDone!');
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
