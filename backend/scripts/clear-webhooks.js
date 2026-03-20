#!/usr/bin/env node
'use strict';

const db = require('../src/config/database');

async function run() {
  try {
    // Tables that reference webhook_events - null out before delete
    const refTables = [
      'signal_rejections',
      'revenue_target_decisions',
      'intelligence_verdicts',
      'sim_trades',
      'sim_orders',
      'sim_positions',
    ];

    for (const table of refTables) {
      try {
        const r = await db.query(
          `UPDATE ${table} SET webhook_event_id = NULL WHERE webhook_event_id IS NOT NULL`
        );
        if (r.rowCount > 0) {
          console.log(`  Cleared webhook_event_id in ${table}: ${r.rowCount} row(s)`);
        }
      } catch (e) {
        if (e.code === '42703' || e.code === '42P01') continue; // column/table doesn't exist
        throw e;
      }
    }

    // sim_account_state has trigger_webhook_event_id and possibly webhook_event_id
    try {
      await db.query(
        `UPDATE sim_account_state SET trigger_webhook_event_id = NULL WHERE trigger_webhook_event_id IS NOT NULL`
      );
    } catch (e) {
      if (e.code !== '42703') throw e;
    }

    const result = await db.query('DELETE FROM webhook_events RETURNING id');
    const count = result.rowCount || 0;
    console.log(`\nDeleted ${count} webhook event(s). Clean start.`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
}

run();
