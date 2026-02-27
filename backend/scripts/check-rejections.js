const db = require('../src/config/database');
(async () => {
  const r = await db.query(
    "SELECT id, indicator_source, rejection_reason FROM webhook_events WHERE indicator_source = 'SIGNALS' AND status = 'REJECTED' ORDER BY created_at DESC LIMIT 5"
  );
  for (const row of r.rows) {
    console.log('---');
    console.log('ID:', row.id);
    console.log('REASON:', row.rejection_reason);
  }
  process.exit(0);
})();
