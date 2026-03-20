#!/usr/bin/env node
'use strict';

/**
 * Run the System Health Assessment (AI insights) from the command line.
 * Requires: DATABASE_URL, ANTHROPIC_API_KEY (or user AI settings with credits)
 * Usage: node scripts/run-system-health-report.js [lookbackDays]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const db = require('../src/config/database');
const aiInsightsService = require('../src/modules/sim/adaptive-intelligence/ai-insights.service');

async function getUserId() {
  const envId = process.env.SIM_DEFAULT_USER_ID;
  if (envId) return envId;

  const r = await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
  if (r.rows.length === 0) throw new Error('No users found. Create a user first.');
  return r.rows[0].id;
}

async function main() {
  const lookbackDays = parseInt(process.argv[2] || '90', 10);
  console.log(`\nSystem Health Assessment — ${new Date().toISOString()}`);
  console.log(`Lookback: ${lookbackDays} days`);
  console.log('─'.repeat(60));

  const userId = await getUserId();
  console.log(`User ID: ${userId}\n`);

  try {
    const result = await aiInsightsService.generateInsights(userId, {
      lookbackDays,
      includeLiveContext: true,
    });

    console.log('\n' + '='.repeat(70));
    console.log('  SYSTEM HEALTH ASSESSMENT');
    console.log('='.repeat(70));
    console.log(result.analysis);
    console.log('\n' + '─'.repeat(60));
    console.log(`Data: ${result.dataSnapshot?.totalTrades || 0} trades, ${lookbackDays}d lookback`);
    console.log(`Credits used: ${result.creditsUsed || 0}, remaining: ${result.creditsRemaining ?? 'N/A'}`);
    console.log(`Generated: ${result.generatedAt}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    if (db.pool) await db.pool.end();
  }
}

main();
