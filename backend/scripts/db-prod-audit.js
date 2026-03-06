/*
 * DB Production Audit (read-only)
 *
 * Usage (run on a machine with access to your production DB):
 *
 *  # Option A: pass connection string as env var
 *  DB_CONN='postgresql://user:pass@host/db?sslmode=require' node backend/scripts/db-prod-audit.js
 *
 *  # Option B: pass as first argument
 *  node backend/scripts/db-prod-audit.js "postgresql://user:pass@host/db?sslmode=require"
 *
 * The script is intentionally read-only. It runs a set of SELECT queries that
 * summarize webhook processing, intelligence verdicts, rejections, sim orders,
 * positions, trades, and global market state. Output is JSON to stdout.
 *
 * SECURITY: Do NOT paste the connection string into chat. Run this script locally
 * and paste only the non-sensitive JSON output here if you want me to analyze it.
 */

const { Client } = require('pg');

async function main() {
  try {
    const conn = process.env.DB_CONN || process.argv[2];
    if (!conn) {
      console.error('\nERROR: No DB connection string provided. Set DB_CONN or pass as first arg.');
      process.exit(2);
    }

    const client = new Client({ connectionString: conn });
    await client.connect();

    console.log('Connected (read-only). Running audit queries...');

    const queries = {
      webhook_stats: `SELECT status, COUNT(*)::int AS count FROM webhook_events GROUP BY status;`,
      recent_webhooks: `SELECT id, user_id, source, indicator_source, status, error_message, received_at, processed_at FROM webhook_events ORDER BY received_at DESC LIMIT 50;`,
      recent_verdicts: `SELECT id, webhook_event_id, symbol, allowed, intelligence_score, rejection_reason, created_at FROM intelligence_verdicts ORDER BY created_at DESC LIMIT 50;`,
      recent_rejections: `SELECT id, webhook_event_id, symbol, strategy, gate, reason, created_at FROM signal_rejections ORDER BY created_at DESC LIMIT 50;`,
      recent_orders: `SELECT id, webhook_event_id, symbol, side, contract_type, quantity, status, rejection_reason, created_at FROM sim_orders ORDER BY created_at DESC LIMIT 20;`,
      recent_fills: `SELECT id, order_id, fill_price, quantity, created_at FROM sim_fills ORDER BY created_at DESC LIMIT 20;`,
      recent_positions: `SELECT id, symbol, underlying_symbol, contract_type, strike, expiration, quantity, status, opened_at, closed_at FROM sim_positions ORDER BY opened_at DESC LIMIT 20;`,
      recent_trades: `SELECT id, position_id, pnl, pnl_percent, entry_price, exit_price, entry_time, exit_time FROM sim_trades ORDER BY exit_time DESC LIMIT 20;`,
      global_market_state: `SELECT symbol, last_price, price_updated_at, chain_ok, chain_updated_at, chain_contracts_count, price_fetch_failures, chain_fetch_failures FROM global_market_state ORDER BY symbol LIMIT 100;`,
      price_cache: `SELECT symbol, price, updated_at FROM price_cache ORDER BY updated_at DESC LIMIT 100;`,
    };

    const result = {};

    for (const [k, q] of Object.entries(queries)) {
      try {
        const res = await client.query(q);
        result[k] = res.rows;
      } catch (err) {
        result[k] = { error: String(err.message) };
      }
    }

    await client.end();

    // Print compact JSON summary
    const summary = {
      timestamp: new Date().toISOString(),
      host: 'db-audit-script',
      counts: {},
      samples: {},
    };

    if (Array.isArray(result.webhook_stats)) {
      for (const r of result.webhook_stats) summary.counts[r.status] = r.count;
    } else {
      summary.counts = result.webhook_stats;
    }

    // include up to 10 sample rows for recent items to keep output small
    summary.samples.recent_webhooks = Array.isArray(result.recent_webhooks) ? result.recent_webhooks.slice(0, 10) : result.recent_webhooks;
    summary.samples.recent_verdicts = Array.isArray(result.recent_verdicts) ? result.recent_verdicts.slice(0, 10) : result.recent_verdicts;
    summary.samples.recent_rejections = Array.isArray(result.recent_rejections) ? result.recent_rejections.slice(0, 10) : result.recent_rejections;
    summary.samples.recent_orders = Array.isArray(result.recent_orders) ? result.recent_orders.slice(0, 10) : result.recent_orders;
    summary.samples.recent_positions = Array.isArray(result.recent_positions) ? result.recent_positions.slice(0, 10) : result.recent_positions;
    summary.samples.recent_trades = Array.isArray(result.recent_trades) ? result.recent_trades.slice(0, 10) : result.recent_trades;

    // Include simple health metrics for market-state and price_cache
    summary.market_state = Array.isArray(result.global_market_state)
      ? result.global_market_state.slice(0, 50).map(r => ({ symbol: r.symbol, last_price: r.last_price, price_updated_at: r.price_updated_at, chain_ok: r.chain_ok, chain_updated_at: r.chain_updated_at, fetch_failures: { price: r.price_fetch_failures, chain: r.chain_fetch_failures } }))
      : result.global_market_state;

    summary.price_cache_head = Array.isArray(result.price_cache) ? result.price_cache.slice(0, 20) : result.price_cache;

    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error('FATAL: ', err && err.message ? err.message : err);
    process.exit(1);
  }
}

main();
