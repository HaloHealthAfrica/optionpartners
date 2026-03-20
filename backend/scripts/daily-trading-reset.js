#!/usr/bin/env node
'use strict';

/**
 * Daily Trading Reset
 * Run at start of trading day to:
 *   1. Deactivate kill switch for all sim users
 *   2. Reset daily PnL tracking
 *   3. Purge stale market data (symbol_state, global_market_state, price_cache)
 *
 * Usage:
 *   node backend/scripts/daily-trading-reset.js
 *   DATABASE_URL=postgres://... node backend/scripts/daily-trading-reset.js
 *
 * Can be run via cron at market open (e.g. 9:30 AM ET) or manually.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('fly') || process.env.DATABASE_URL?.includes('sslmode')
    ? { rejectUnauthorized: false }
    : false,
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('═'.repeat(60));
    console.log('  DAILY TRADING RESET');
    console.log(`  ${new Date().toISOString()}`);
    console.log('═'.repeat(60));

    await client.query('BEGIN');

    // 1. Deactivate kill switch for all sim users
    const killSwitch = await client.query(`
      UPDATE sim_account_state
      SET kill_switch_active = FALSE, updated_at = NOW()
      WHERE kill_switch_active = TRUE
      RETURNING user_id
    `);
    console.log(`\n1. Kill switch: deactivated for ${killSwitch.rowCount} user(s)`);

    // 2. Reset daily PnL tracking for today (so daily_pnl_reset_at = today)
    const pnlReset = await client.query(`
      UPDATE sim_account_state
      SET daily_pnl_reset_at = CURRENT_DATE AT TIME ZONE 'UTC',
          daily_pnl = 0,
          updated_at = NOW()
      WHERE daily_pnl_reset_at IS NULL OR daily_pnl_reset_at::date < CURRENT_DATE
      RETURNING user_id
    `);
    console.log(`2. Daily PnL: reset for ${pnlReset.rowCount} user(s)`);

    // 3. Purge symbol_state (forces fresh state on next webhook)
    const symbolState = await client.query('DELETE FROM symbol_state');
    console.log(`3. Symbol state: purged ${symbolState.rowCount} row(s)`);

    // 4. Clear global_market_state price/chain data (forces refresh on next poll)
    const gms = await client.query(`
      UPDATE global_market_state
      SET last_price = NULL, price_high = NULL, price_low = NULL, price_open = NULL,
          price_volume = NULL, price_updated_at = NULL,
          chain_ok = FALSE, chain_contracts_count = 0, chain_open_interest = 0,
          chain_volume = 0, chain_updated_at = NULL,
          price_fetch_failures = 0, chain_fetch_failures = 0,
          last_price_error = NULL, last_chain_error = NULL,
          updated_at = NOW()
    `);
    console.log(`4. Global market state: cleared price/chain for ${gms.rowCount} symbol(s)`);

    // 5. Purge price_cache
    const priceCache = await client.query('TRUNCATE price_cache');
    console.log('5. Price cache: truncated');

    // 6. Prune old data_service_health_log (keep last 24h)
    const healthLog = await client.query(`
      DELETE FROM data_service_health_log
      WHERE created_at < NOW() - INTERVAL '24 hours'
    `);
    console.log(`6. Data service health log: pruned ${healthLog.rowCount} old row(s)`);

    await client.query('COMMIT');

    console.log('\n✓ Daily trading reset complete. System ready for fresh trading.');
    console.log('═'.repeat(60));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('✗ Daily trading reset failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
