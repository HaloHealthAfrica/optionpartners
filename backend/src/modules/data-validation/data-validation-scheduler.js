/**
 * Data Provider Validation Scheduler
 * Runs at 6:00, 8:00, 9:00 AM ET, then hourly 9:00 AM - 4:30 PM ET (market hours)
 */

const cron = require('node-cron');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const { executeRun } = require('./validation-executor');

// ET schedule: 06:00, 08:00, 09:00, 10:00, 11:00, 12:00, 13:00, 14:00, 15:00, 16:00, 16:30
const SCHEDULED_MINUTES_ET = [
  { h: 6, m: 0 },
  { h: 8, m: 0 },
  { h: 9, m: 0 },
  { h: 10, m: 0 },
  { h: 11, m: 0 },
  { h: 12, m: 0 },
  { h: 13, m: 0 },
  { h: 14, m: 0 },
  { h: 15, m: 0 },
  { h: 16, m: 0 },
  { h: 16, m: 30 },
];

function getETNow() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  return { hour, minute };
}

function isScheduledSlot(et) {
  return SCHEDULED_MINUTES_ET.some((s) => s.h === et.hour && s.m === et.minute);
}

/** Build scheduled_at for a slot in ET (stored as UTC) */
function slotToScheduledAt(slot, dateStr) {
  const iso = `${dateStr}T${String(slot.h).padStart(2, '0')}:${String(slot.m).padStart(2, '0')}:00`;
  return new Date(iso + '-05:00');
}

async function ensureTodaySlots() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = formatter.format(now); // YYYY-MM-DD

  for (const slot of SCHEDULED_MINUTES_ET) {
    const scheduledAt = slotToScheduledAt(slot, today);
    if (scheduledAt > now) continue;

    const r = await db.query(
      `SELECT 1 FROM data_validation_run WHERE scheduled_at = $1`,
      [scheduledAt]
    );
    if (r.rows.length > 0) continue;

    await db.query(`INSERT INTO data_validation_run (scheduled_at, status) VALUES ($1, 'pending')`, [scheduledAt]);
  }
}

async function runScheduledValidation() {
  const et = getETNow();
  if (!isScheduledSlot(et)) return;

  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = formatter.format(now); // YYYY-MM-DD
  const scheduledAt = slotToScheduledAt({ h: et.hour, m: et.minute }, today);

  const existing = await db.query(
    `SELECT id, scheduled_at, status FROM data_validation_run WHERE scheduled_at = $1`,
    [scheduledAt]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.status && !['pending', 'running'].includes(row.status)) return;
  } else {
    await db.query(`INSERT INTO data_validation_run (scheduled_at, status) VALUES ($1, 'pending')`, [scheduledAt]);
  }

  const runScheduledAt = existing.rows[0]?.scheduled_at || scheduledAt;

  try {
    logger.info(`[DataValidation] Running scheduled validation for ${et.hour}:${String(et.minute).padStart(2, '0')} ET`, 'data-validation');
    await executeRun(runScheduledAt);
  } catch (err) {
    logger.error(`[DataValidation] Validation run failed: ${err.message}`, 'data-validation');
  }
}

let tickJob = null;

function start() {
  if (tickJob) return;
  tickJob = cron.schedule('* * * * *', async () => {
    try {
      await ensureTodaySlots();
      await runScheduledValidation();
    } catch (err) {
      logger.error(`[DataValidation] Scheduler tick error: ${err.message}`, 'data-validation');
    }
  });
  logger.info('[DataValidation] Scheduler started (ET: 6AM, 8AM, 9AM, hourly 9AM-4:30PM)', 'data-validation');
}

function stop() {
  if (tickJob) {
    tickJob.stop();
    tickJob = null;
  }
}

module.exports = { start, stop, runScheduledValidation, executeRun, ensureTodaySlots };
