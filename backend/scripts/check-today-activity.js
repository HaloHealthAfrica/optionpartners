#!/usr/bin/env node
'use strict';

const db = require('../src/config/database');

async function checkTodayActivity() {
  try {
    console.log('=== Trading Activity Audit for Today ===\n');
    
    // Check webhook events received today
    const webhookQuery = `
      SELECT 
        COUNT(*) as total_webhooks,
        COUNT(*) FILTER (WHERE status = 'RECEIVED') as received,
        COUNT(*) FILTER (WHERE status = 'PROCESSED') as processed,
        COUNT(*) FILTER (WHERE status = 'REJECTED') as rejected,
        MAX(received_at) as latest_webhook
      FROM webhook_events 
      WHERE DATE(received_at AT TIME ZONE 'UTC') = CURRENT_DATE;
    `;
    
    const webhookResult = await db.query(webhookQuery);
    const webhookStats = webhookResult.rows[0];
    
    console.log('📥 WEBHOOK ACTIVITY:');
    console.log(`  Total webhooks received today: ${webhookStats.total_webhooks}`);
    console.log(`  Status breakdown:`);
    console.log(`    - RECEIVED (pending): ${webhookStats.received}`);
    console.log(`    - PROCESSED: ${webhookStats.processed}`);
    console.log(`    - REJECTED: ${webhookStats.rejected}`);
    console.log(`  Latest webhook: ${webhookStats.latest_webhook || 'None'}\n`);
    
    // Check sim trades executed today
    const tradesQuery = `
      SELECT 
        COUNT(*) as total_trades,
        COUNT(*) FILTER (WHERE status = 'OPEN') as open_trades,
        COUNT(*) FILTER (WHERE status = 'CLOSED') as closed_trades,
        SUM(CASE WHEN status = 'CLOSED' THEN realized_pnl ELSE 0 END) as total_pnl,
        MAX(entry_time) as latest_trade
      FROM sim_trades 
      WHERE DATE(entry_time AT TIME ZONE 'UTC') = CURRENT_DATE;
    `;
    
    const tradesResult = await db.query(tradesQuery);
    const tradeStats = tradesResult.rows[0];
    
    console.log('💼 TRADING ACTIVITY:');
    console.log(`  Total trades today: ${tradeStats.total_trades}`);
    console.log(`  Status breakdown:`);
    console.log(`    - OPEN: ${tradeStats.open_trades}`);
    console.log(`    - CLOSED: ${tradeStats.closed_trades}`);
    console.log(`  Total P&L: $${parseFloat(tradeStats.total_pnl || 0).toFixed(2)}`);
    console.log(`  Latest trade: ${tradeStats.latest_trade || 'None'}\n`);
    
    // Check recent webhook details (last 10)
    const recentWebhooksQuery = `
      SELECT 
        id,
        received_at,
        status,
        raw_payload->>'symbol' as symbol,
        raw_payload->>'source' as source,
        raw_payload->>'direction' as direction,
        error_message
      FROM webhook_events 
      WHERE DATE(received_at AT TIME ZONE 'UTC') = CURRENT_DATE
      ORDER BY received_at DESC
      LIMIT 10;
    `;
    
    const recentWebhooks = await db.query(recentWebhooksQuery);
    
    if (recentWebhooks.rows.length > 0) {
      console.log('📋 RECENT WEBHOOKS (Last 10):');
      recentWebhooks.rows.forEach((wh, idx) => {
        console.log(`  ${idx + 1}. [${wh.status}] ${wh.source || 'unknown'} - ${wh.symbol || 'N/A'} ${wh.direction || ''}`);
        console.log(`     Time: ${wh.received_at}`);
        if (wh.error_message) {
          console.log(`     Error: ${wh.error_message}`);
        }
      });
      console.log();
    }
    
    // Check if webhook processor is enabled
    console.log('⚙️  CONFIGURATION:');
    console.log(`  Trading Mode: ${process.env.TRADING_MODE || 'Not set'}`);
    console.log(`  Webhook Processor Enabled: ${process.env.ENABLE_WEBHOOK_PROCESSOR || 'Not set'}`);
    console.log(`  Processor Interval: ${process.env.WEBHOOK_PROCESSOR_INTERVAL || 'Not set'}ms`);
    
  } catch (error) {
    console.error('Error checking activity:', error);
  } finally {
    await db.pool.end();
  }
}

checkTodayActivity();
