#!/usr/bin/env node
const db = require('../src/config/database');
db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='webhook_events' ORDER BY ordinal_position`)
  .then(r => { console.log(JSON.stringify(r.rows, null, 2)); return db.pool.end(); })
  .catch(e => { console.error(e.message); db.pool.end(); process.exit(1); });
