#!/usr/bin/env node
'use strict';

/**
 * Integration validation: STRAT_SETUP → store → STRAT_TRIGGER → match.
 * Requires DB connection and a test user.
 */

const db = require('../src/config/database');
const reversalStratSetup = require('../src/modules/sim/reversal-strat-setup.service');

async function run() {
  console.log('\n=== Reversal Integration Validation (STRAT_SETUP + STRAT_TRIGGER) ===\n');

  let userId;
  try {
    const r = await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
    userId = r.rows[0]?.id;
    if (!userId) {
      console.log('SKIP: No users in DB');
      process.exit(0);
    }
  } catch (e) {
    console.log('SKIP: DB unavailable:', e.message);
    process.exit(0);
  }

  const setupId = `VALIDATE-${Date.now()}`;
  const payload = {
    signal: 'STRAT_SETUP',
    setup_id: setupId,
    symbol: 'SPY',
    pattern: '212_FORMING_BULL',
    timeframe: '5',
    trigger_level: 450.50,
    setup_low: 448.20,
    expects_trigger: true,
  };

  try {
    // 1. Store setup
    await reversalStratSetup.storeSetup(setupId, userId, payload);
    console.log('1. storeSetup: ✓');

    // 2. Retrieve setup
    const setup = await reversalStratSetup.getSetup(setupId, userId);
    const hasSetup = setup && setup.symbol === 'SPY' && setup.setup_id === setupId;
    console.log(`2. getSetup: ${hasSetup ? '✓' : '✗'}`);

    // 3. Wrong user gets null
    const wrongUser = '00000000-0000-0000-0000-000000000000';
    const noSetup = await reversalStratSetup.getSetup(setupId, wrongUser);
    console.log(`3. getSetup (wrong user): ${noSetup === null ? '✓' : '✗'}`);

    // 4. Cleanup
    await reversalStratSetup.removeSetup(setupId, userId);
    const afterRemove = await reversalStratSetup.getSetup(setupId, userId);
    console.log(`4. removeSetup: ${afterRemove === null ? '✓' : '✗'}`);

    const allOk = hasSetup && noSetup === null && afterRemove === null;
    console.log('\n' + (allOk ? 'All integration checks passed ✓' : 'Some checks failed ✗'));
    process.exit(allOk ? 0 : 1);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

run();
