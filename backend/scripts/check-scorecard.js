#!/usr/bin/env node
'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
(async () => {
  const r = await pool.query('SELECT strategy, total_trades, win_rate, profit_factor, status FROM strategy_scorecard ORDER BY strategy');
  console.log('STRATEGY SCORECARD:');
  r.rows.forEach(s => {
    console.log(`  ${s.strategy}: trades=${s.total_trades} WR=${(parseFloat(s.win_rate) * 100).toFixed(1)}% PF=${s.profit_factor} status=${s.status}`);
  });

  console.log('\nSUPPRESSED_STRATEGIES env:', JSON.stringify(process.env.SUPPRESSED_STRATEGIES));
  console.log('Falsy check:', !process.env.SUPPRESSED_STRATEGIES);

  const pending = await pool.query(`
    SELECT indicator_source, status, COUNT(*)::int as cnt
    FROM webhook_events
    WHERE received_at >= NOW() - INTERVAL '15 minutes'
    GROUP BY indicator_source, status
    ORDER BY indicator_source, status
  `);
  console.log('\nLAST 15 MIN WEBHOOKS:');
  pending.rows.forEach(r => console.log(`  ${r.indicator_source} [${r.status}]: ${r.cnt}`));

  const rej = await pool.query(`
    SELECT gate, reason, created_at
    FROM signal_rejections
    WHERE created_at >= NOW() - INTERVAL '15 minutes'
    ORDER BY created_at DESC LIMIT 10
  `);
  console.log('\nLAST 15 MIN REJECTIONS:');
  rej.rows.forEach(r => console.log(`  [${r.gate}] ${r.reason.substring(0, 100)}`));

  await pool.end();
})();
