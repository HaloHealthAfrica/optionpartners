'use strict';

/**
 * Daily Trading Reset Scheduler
 * Runs at 9:30 AM ET (market open) on weekdays to:
 *   - Deactivate kill switch
 *   - Reset daily PnL tracking
 *   - Purge stale market data (symbol_state, global_market_state, price_cache)
 */

const cron = require('node-cron');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');

function getETDate() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date()); // YYYY-MM-DD
}

function getETNow() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  return { hour, minute, dayOfWeek };
}

async function runDailyReset() {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const killSwitch = await client.query(`
      UPDATE sim_account_state SET kill_switch_active = FALSE, updated_at = NOW()
      WHERE kill_switch_active = TRUE RETURNING user_id
    `);

    await client.query(`
      UPDATE sim_account_state
      SET daily_pnl_reset_at = CURRENT_DATE AT TIME ZONE 'UTC', daily_pnl = 0, updated_at = NOW()
      WHERE daily_pnl_reset_at IS NULL OR daily_pnl_reset_at::date < CURRENT_DATE
    `);

    const symbolState = await client.query('DELETE FROM symbol_state');
    await client.query(`
      UPDATE global_market_state
      SET last_price = NULL, price_high = NULL, price_low = NULL, price_open = NULL,
          price_volume = NULL, price_updated_at = NULL,
          chain_ok = FALSE, chain_contracts_count = 0, chain_open_interest = 0,
          chain_volume = 0, chain_updated_at = NULL,
          price_fetch_failures = 0, chain_fetch_failures = 0,
          last_price_error = NULL, last_chain_error = NULL, updated_at = NOW()
    `);
    await client.query('TRUNCATE price_cache');
    await client.query(`
      DELETE FROM data_service_health_log WHERE created_at < NOW() - INTERVAL '24 hours'
    `);

    await client.query('COMMIT');

    logger.info(
      `[DailyTradingReset] Complete — kill_switch=${killSwitch.rowCount} symbol_state=${symbolState.rowCount}`,
      'sim'
    );
    return { killSwitchDeactivated: killSwitch.rowCount, symbolStatePurged: symbolState.rowCount };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`[DailyTradingReset] Failed: ${err.message}`, 'sim');
    Sentry.captureException(err, { tags: { module: 'daily-trading-reset-scheduler' } });
    throw err;
  } finally {
    client.release();
  }
}

let tickJob = null;
let lastRunDate = null;

function start() {
  if (tickJob) return;

  // Run every minute, check if it's 9:30 AM ET on a weekday
  tickJob = cron.schedule('* * * * *', async () => {
    try {
      const et = getETNow();
      const today = getETDate();

      // Skip weekends
      if (et.dayOfWeek === 0 || et.dayOfWeek === 6) return;

      // Run at 9:30 AM ET only, and only once per day
      if (et.hour === 9 && et.minute === 30 && lastRunDate !== today) {
        lastRunDate = today;
        await runDailyReset();
      }
    } catch (err) {
      logger.error(`[DailyTradingReset] Scheduler tick error: ${err.message}`, 'sim');
    }
  });

  logger.info('[DailyTradingReset] Scheduler started (9:30 AM ET, weekdays)', 'sim');
}

function stop() {
  if (tickJob) {
    tickJob.stop();
    tickJob = null;
  }
}

module.exports = { start, stop, runDailyReset };
