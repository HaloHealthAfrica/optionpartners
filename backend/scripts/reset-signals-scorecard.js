#!/usr/bin/env node
'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
(async () => {
  console.log('=== SIGNALS Scorecard Reset ===');

  const before = await pool.query(
    "SELECT strategy, total_trades, win_rate, profit_factor, status FROM strategy_scorecard WHERE strategy = 'SIGNALS'"
  );
  if (before.rows.length) {
    const s = before.rows[0];
    console.log(`BEFORE: trades=${s.total_trades} WR=${(parseFloat(s.win_rate)*100).toFixed(1)}% PF=${s.profit_factor} status=${s.status}`);
  } else {
    console.log('BEFORE: no scorecard row');
  }

  await pool.query("DELETE FROM strategy_scorecard WHERE strategy = 'SIGNALS'");
  console.log('DELETED SIGNALS scorecard row');

  const after = await pool.query(
    "SELECT strategy, total_trades, win_rate, profit_factor, status FROM strategy_scorecard WHERE strategy = 'SIGNALS'"
  );
  console.log(`AFTER: ${after.rows.length === 0 ? 'scorecard cleared — gate will allow trades until 5 new trades accumulate' : 'ERROR: row still exists'}`);

  await pool.end();
})();
