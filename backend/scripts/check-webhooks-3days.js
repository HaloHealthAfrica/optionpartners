#!/usr/bin/env node
'use strict';

const db = require('../src/config/database');

async function run() {
  try {
    const result = await db.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'RECEIVED')::int AS received,
        COUNT(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
        COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
        MIN(received_at) AS earliest,
        MAX(received_at) AS latest
      FROM webhook_events 
      WHERE received_at >= NOW() - INTERVAL '3 days'
    `);
    const row = result.rows[0];
    console.log('Webhooks in past 3 days:');
    console.log('  Total:', row.total);
    console.log('  RECEIVED (pending):', row.received);
    console.log('  PROCESSED:', row.processed);
    console.log('  REJECTED:', row.rejected);
    console.log('  Earliest:', row.earliest || 'None');
    console.log('  Latest:', row.latest || 'None');

    if (row.total > 0) {
      const recent = await db.query(`
        SELECT id, received_at, status, indicator_source, error_message,
               raw_payload->>'symbol' AS symbol, raw_payload->>'ticker' AS ticker
        FROM webhook_events 
        WHERE received_at >= NOW() - INTERVAL '3 days'
        ORDER BY received_at DESC
        LIMIT 10
      `);
      console.log('\nLast 10 webhooks:');
      recent.rows.forEach((w, i) => {
        console.log(`  ${i + 1}. [${w.status}] ${w.indicator_source || '?'} ${w.symbol || w.ticker || 'N/A'} @ ${w.received_at}`);
        if (w.error_message) console.log(`     Error: ${w.error_message}`);
      });
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
}

run();
