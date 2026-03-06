#!/usr/bin/env node
'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
(async () => {
  // TRADE_ENGINE rejection sub-categories
  const r1 = await pool.query(`
    SELECT rejection_reason, COUNT(*)::int as cnt
    FROM signal_rejections
    WHERE gate = 'TRADE_ENGINE'
      AND created_at >= CURRENT_DATE
    GROUP BY rejection_reason
    ORDER BY cnt DESC
  `);
  console.log('TRADE_ENGINE rejection sub-categories:');
  r1.rows.forEach(r => console.log(`  ${r.rejection_reason || 'null'}: ${r.cnt}`));

  // EXPECTED_MOVE rejection details (last 5)
  const r2 = await pool.query(`
    SELECT symbol, reason, created_at
    FROM signal_rejections
    WHERE gate = 'EXPECTED_MOVE'
      AND created_at >= CURRENT_DATE
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log('\nEXPECTED_MOVE recent rejections:');
  r2.rows.forEach(r => console.log(`  [${r.created_at.toISOString().slice(11,19)}] ${r.symbol}: ${r.reason.substring(0, 120)}`));

  // ADAPTIVE_GUARD rejection details
  const r3 = await pool.query(`
    SELECT symbol, reason, created_at
    FROM signal_rejections
    WHERE gate = 'ADAPTIVE_GUARD'
      AND created_at >= CURRENT_DATE
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log('\nADAPTIVE_GUARD recent rejections:');
  r3.rows.forEach(r => console.log(`  [${r.created_at.toISOString().slice(11,19)}] ${r.symbol}: ${r.reason.substring(0, 120)}`));

  // Open positions
  const r4 = await pool.query(`
    SELECT symbol, contract_type, strike, status, opened_at, unrealized_pnl
    FROM sim_positions
    WHERE status = 'OPEN'
    ORDER BY opened_at DESC
  `);
  console.log('\nOPEN POSITIONS:');
  if (r4.rows.length === 0) console.log('  (none)');
  r4.rows.forEach(r => console.log(`  ${r.symbol} ${r.contract_type} ${r.strike} status=${r.status} pnl=${r.unrealized_pnl}`));

  // Check what the strategy_cooldowns look like
  const r5 = await pool.query(`
    SELECT strategy, cooldown_until, reason
    FROM strategy_cooldowns
    WHERE cooldown_until > NOW()
  `);
  console.log('\nACTIVE COOLDOWNS:');
  if (r5.rows.length === 0) console.log('  (none)');
  r5.rows.forEach(r => console.log(`  ${r.strategy}: until ${r.cooldown_until.toISOString()} — ${r.reason}`));

  await pool.end();
})();
