const { Pool } = require('pg');
const p = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode') ? { rejectUnauthorized: false } : false
});
const q = `SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE status = 'RECEIVED')::int as received, COUNT(*) FILTER (WHERE status = 'PROCESSED')::int as processed, COUNT(*) FILTER (WHERE status = 'REJECTED')::int as rejected, MIN(received_at) as earliest, MAX(received_at) as latest FROM webhook_events WHERE received_at >= NOW() - INTERVAL '3 days'`;
p.query(q).then(r => { console.log(JSON.stringify(r.rows[0], null, 2)); p.end(); }).catch(e => { console.error(e.message); p.end(); process.exit(1); });
