#!/usr/bin/env node
'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
(async () => {
  const r = await pool.query(`
    SELECT DISTINCT u.id, u.email, u.username
    FROM users u
    JOIN sim_orders o ON o.user_id = u.id
    WHERE o.created_at >= CURRENT_DATE
    ORDER BY u.email
  `);
  console.log('Users with trades today:');
  r.rows.forEach(x => console.log(`  id=${x.id}  email=${x.email}  username=${x.username}`));
  if (r.rows.length === 0) console.log('  (none)');

  // Check webhook_events user_id distribution
  const w = await pool.query(`
    SELECT user_id, COUNT(*)::int as cnt
    FROM webhook_events
    WHERE received_at >= CURRENT_DATE
    GROUP BY user_id
    ORDER BY cnt DESC
  `);
  console.log('\nWebhook events user_id distribution today:');
  w.rows.forEach(x => console.log(`  user_id=${x.user_id}  count=${x.cnt}`));

  // Check all users in the system
  const u = await pool.query('SELECT id, email, username FROM users ORDER BY created_at');
  console.log('\nAll users:');
  u.rows.forEach(x => console.log(`  id=${x.id}  email=${x.email}  username=${x.username}`));

  // Check env vars
  console.log('\nSIM_DEFAULT_USER_ID:', process.env.SIM_DEFAULT_USER_ID || '(not set)');
  console.log('NODE_ENV:', process.env.NODE_ENV || '(not set)');

  await pool.end();
})();
