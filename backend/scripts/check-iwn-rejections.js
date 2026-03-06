#!/usr/bin/env node
'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
(async () => {
  const r = await pool.query(`
    SELECT id, indicator_source, raw_payload->>'ticker' as ticker,
           raw_payload->>'direction' as direction,
           status, error_message, received_at
    FROM webhook_events
    WHERE raw_payload->>'ticker' = 'IWN'
    ORDER BY received_at DESC LIMIT 5
  `);
  console.log('RECENT IWN WEBHOOKS:');
  r.rows.forEach(w => {
    console.log(`  ${w.id.slice(0,8)} | ${w.indicator_source} | ${w.ticker} ${w.direction} | ${w.status} | ${(w.error_message || '').slice(0, 200)}`);
  });

  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='signal_rejections' ORDER BY ordinal_position
  `);
  console.log('\nsignal_rejections columns:', cols.rows.map(r => r.column_name).join(', '));

  const rej = await pool.query(`
    SELECT sr.*, we.raw_payload->>'ticker' as ticker
    FROM signal_rejections sr
    JOIN webhook_events we ON sr.webhook_event_id = we.id
    WHERE we.raw_payload->>'ticker' = 'IWN'
    ORDER BY sr.created_at DESC LIMIT 10
  `);
  console.log('\nIWN REJECTIONS:');
  rej.rows.forEach(r => {
    console.log(`  gate=${r.gate} | ${r.rejection_reason || r.reason?.slice(0, 250)}`);
  });

  const vcols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='intelligence_verdicts' ORDER BY ordinal_position
  `);
  console.log('\nintelligence_verdicts columns:', vcols.rows.map(r => r.column_name).join(', '));

  const verdicts = await pool.query(`
    SELECT iv.webhook_event_id, iv.verdict, iv.conviction_score, iv.reasoning, iv.created_at
    FROM intelligence_verdicts iv
    JOIN webhook_events we ON iv.webhook_event_id = we.id
    WHERE we.raw_payload->>'ticker' = 'IWN'
    ORDER BY iv.created_at DESC LIMIT 5
  `);
  console.log('\nIWN INTELLIGENCE VERDICTS:');
  verdicts.rows.forEach(v => {
    console.log(`  ${v.webhook_event_id?.slice(0,8)} | ${v.verdict} | conv=${v.conviction_score} | ${(v.reasoning || '').slice(0, 150)}`);
  });

  await pool.end();
})();
