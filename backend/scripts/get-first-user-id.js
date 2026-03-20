#!/usr/bin/env node
'use strict';
const db = require('../src/config/database');
db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1')
  .then(r => {
    const id = r.rows[0]?.id;
    console.log(id || 'NO_USERS');
    process.exit(id ? 0 : 1);
  })
  .catch(e => {
    console.error(e.message);
    process.exit(1);
  });
