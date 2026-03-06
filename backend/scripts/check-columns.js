const db = require('../src/config/database');

(async () => {
  try {
    const tables = ['volatility_snapshots', 'gex_snapshots', 'symbol_state', 'ai_auto_insights', 'sim_intelligence_config'];
    for (const table of tables) {
      const r = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`,
        [table]
      );
      if (r.rows.length === 0) {
        console.log(`${table}: TABLE DOES NOT EXIST`);
      } else {
        console.log(`${table}: ${r.rows.map(r => r.column_name).join(', ')}`);
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
  process.exit(0);
})();
