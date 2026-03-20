#!/usr/bin/env node
'use strict';

/**
 * Replay webhooks at a paced interval to observe processing behavior.
 * Fetches up to N webhooks from the DB, creates replay copies, and processes
 * them one-by-one with a delay between each.
 *
 * Usage:
 *   node scripts/replay-webhooks-paced.js [--limit=100] [--interval=5000] [--days=30]
 *
 * Defaults: limit=100, interval=5000 (5s), days=30
 *
 * Run locally:  cd backend && node scripts/replay-webhooks-paced.js
 * Run on Fly:   fly ssh console -a marketplaybook -C "node /app/backend/scripts/replay-webhooks-paced.js"
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../src/config/database');
const webhookProcessor = require('../src/modules/sim/webhook-processor');
const { detectIndicatorSource } = require('../src/modules/webhooks/indicator-detector');

const LIMIT = parseInt(process.env.REPLAY_LIMIT || process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '100', 10);
const INTERVAL_MS = parseInt(process.env.REPLAY_INTERVAL_MS || process.argv.find(a => a.startsWith('--interval='))?.split('=')[1] || '5000', 10);
const DAYS = parseInt(process.env.REPLAY_DAYS || process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || '30', 10);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  console.log(`\nReplay webhooks: limit=${LIMIT}, interval=${INTERVAL_MS}ms, days=${DAYS}\n`);

  // Discover schema - marketplaybook prod has: payload, created_at, no user_id/dedupe_key
  const cols = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'webhook_events'
     ORDER BY ordinal_position`
  ).then(r => r.rows.map(x => x.column_name)).catch(() => []);

  const payloadCol = cols.includes('raw_payload') ? 'raw_payload' : cols.includes('payload') ? 'payload' : null;
  const dateCol = cols.includes('received_at') ? 'received_at' : cols.includes('created_at') ? 'created_at' : null;
  const hasUserId = cols.includes('user_id');
  const hasDedupeKey = cols.includes('dedupe_key');

  if (!payloadCol || !dateCol) {
    console.error(`Schema incompatible: payloadCol=${payloadCol}, dateCol=${dateCol}. Columns: ${cols.join(', ')}`);
    await db.pool.end();
    process.exit(1);
  }

  // Default user when schema has no user_id (marketplaybook)
  let defaultUserId = process.env.SIM_DEFAULT_USER_ID;
  if (!defaultUserId) {
    const u = await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').then(r => r.rows[0]?.id);
    defaultUserId = u;
  }
  if (!defaultUserId) {
    console.error('No user_id in schema and no SIM_DEFAULT_USER_ID or users in DB');
    await db.pool.end();
    process.exit(1);
  }

  const userFilter = hasUserId ? 'AND user_id IS NOT NULL' : '';
  const fetchResult = await db.query(
    `SELECT id, status, ${payloadCol} as raw_payload${hasUserId ? ', user_id' : ''}
     FROM webhook_events
     WHERE ${dateCol} >= NOW() - (INTERVAL '1 day' * $1)
       AND ${payloadCol} IS NOT NULL
       AND (${payloadCol}->>'test' IS NULL OR ${payloadCol}->>'test' != 'true')
       ${userFilter}
     ORDER BY ${dateCol} ASC
     LIMIT $2`,
    [DAYS, LIMIT]
  );

  const source = fetchResult.rows;
  if (source.length === 0) {
    console.log('No webhooks found in the specified period.');
    await db.pool.end();
    process.exit(0);
  }

  console.log(`Found ${source.length} webhook(s). Creating replay copies and processing at ${INTERVAL_MS / 1000}s intervals...\n`);

  const results = { processed: 0, approved: 0, rejected: 0, contextUpdate: 0, skipped: 0, error: 0 };
  const startTime = Date.now();

  for (let i = 0; i < source.length; i++) {
    const orig = source[i];
    const payload = typeof orig.raw_payload === 'string' ? JSON.parse(orig.raw_payload) : orig.raw_payload;
    const indicatorSource = detectIndicatorSource(payload);
    const userId = orig.user_id || defaultUserId;
    const symbol = payload.ticker || payload.symbol || payload.meta?.ticker || '?';

    // Insert replay copy (schema-aware)
    const replayId = uuidv4();
    const payloadJson = JSON.stringify(payload);
    const strategyCol = cols.includes('indicator_source') ? 'indicator_source' : cols.includes('strategy_detected') ? 'strategy_detected' : null;

    if (hasDedupeKey) {
      const dedupeKey = `replay_${replayId}`;
      const parts = ['id', 'source', payloadCol, 'signature_valid', 'dedupe_key', 'status', 'error_message'];
      const vals = [replayId, 'tradingview', payloadJson, true, dedupeKey, 'RECEIVED', null];
      if (strategyCol) { parts.splice(2, 0, strategyCol); vals.splice(2, 0, indicatorSource); }
      if (hasUserId) { parts.push('user_id'); vals.push(userId); }
      const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
      await db.query(`INSERT INTO webhook_events (${parts.join(', ')}) VALUES (${ph})`, vals);
    } else {
      // marketplaybook: payload, status, strategy_detected, no dedupe_key
      const parts = ['id', 'source', payloadCol, 'status'];
      const vals = [replayId, 'tradingview', payloadJson, 'RECEIVED'];
      if (strategyCol) { parts.push(strategyCol); vals.push(indicatorSource); }
      const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
      await db.query(`INSERT INTO webhook_events (${parts.join(', ')}) VALUES (${ph})`, vals);
    }

    const event = (await db.query('SELECT * FROM webhook_events WHERE id = $1', [replayId])).rows[0];
    event.user_id = userId;
    event.raw_payload = event[payloadCol] || event.raw_payload || event.payload;

    try {
      const result = await webhookProcessor.processEvent(event);
      if (result.skipped) {
        results.skipped++;
        console.log(`  ${i + 1}/${source.length} [SKIP] ${symbol} — ${result.reason}`);
      } else if (result.contextUpdate) {
        results.contextUpdate++;
        console.log(`  ${i + 1}/${source.length} [CONTEXT] ${symbol} ${indicatorSource}`);
      } else if (result.approved) {
        results.approved++;
        const exec = result.executed ? 'EXECUTED' : 'NO FILL';
        console.log(`  ${i + 1}/${source.length} [${exec}] ${symbol} ${indicatorSource}`);
      } else {
        results.rejected++;
        console.log(`  ${i + 1}/${source.length} [REJECTED] ${symbol} — ${result.reason || 'N/A'}`);
      }
      results.processed++;
    } catch (err) {
      results.error++;
      console.log(`  ${i + 1}/${source.length} [ERROR] ${symbol} — ${err.message}`);
    }

    if (i < source.length - 1) {
      await sleep(INTERVAL_MS);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n--- Summary ---`);
  console.log(`  Processed: ${results.processed}`);
  console.log(`  Approved+Executed: ${results.approved}`);
  console.log(`  Rejected: ${results.rejected}`);
  console.log(`  Context-only: ${results.contextUpdate}`);
  console.log(`  Skipped: ${results.skipped}`);
  console.log(`  Errors: ${results.error}`);
  console.log(`  Elapsed: ${elapsed}s`);

  await db.pool.end();
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
