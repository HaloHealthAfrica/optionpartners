#!/usr/bin/env node
'use strict';
const email = process.argv[2] || process.env.EMAIL;
if (!email) {
  console.error('Usage: node get-user-by-email.js <email>');
  process.exit(1);
}
const db = require('../src/config/database');
db.query('SELECT id, email, username, full_name, role FROM users WHERE LOWER(email) = LOWER($1)', [email])
  .then(r => {
    if (r.rows.length === 0) {
      console.log('NOT_FOUND');
      process.exit(1);
    }
    const u = r.rows[0];
    console.log('id:', u.id);
    console.log('email:', u.email);
    console.log('username:', u.username);
    console.log('full_name:', u.full_name);
    console.log('role:', u.role);
    process.exit(0);
  })
  .catch(e => {
    console.error(e.message);
    process.exit(1);
  });
