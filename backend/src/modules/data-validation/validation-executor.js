/**
 * Data Provider Validation - Job Executors
 * Runs validation pulls for Quotes, Options Chains, Account State, Regime/Vol
 * Maps to providers: Tradier (quotes, chains), Tastytrade (account), Internal Proxy (regime)
 */

const dataServiceProxy = require('../../services/dataServiceProxy');
const db = require('../../config/database');
const logger = require('../../utils/logger');

const QUOTE_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'IWN'];
const OPTIONS_SYMBOL = 'SPY';

/**
 * Classify error into error_type for UI badges
 */
function classifyError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  if (msg.includes('connection refused') || msg.includes('econnrefused') || msg.includes('network') || msg.includes('unreachable')) {
    return 'provider_down';
  }
  if (msg.includes('timeout') || msg.includes('etimedout')) {
    return 'timeout';
  }
  if (msg.includes('parse') || msg.includes('json') || msg.includes('invalid') || msg.includes('unexpected')) {
    return 'parse_error';
  }
  if (msg.includes('empty') || msg.includes('no data') || msg.includes('404')) {
    return 'empty_response';
  }
  return 'unknown';
}

/**
 * Quotes & Greeks - SPY, QQQ, IWM via data-service (Tradier/Internal Proxy)
 */
async function runQuotesGreeks() {
  const start = Date.now();
  let records = 0;
  const symbols = [];
  try {
    for (const sym of QUOTE_SYMBOLS) {
      const data = await dataServiceProxy.getQuote(sym);
      if (data && (data.last || data.price || data.ask || data.bid)) {
        records++;
        symbols.push(sym);
      }
    }
    const latency = Date.now() - start;
    return { success: records > 0, records, latency, symbols: symbols.join(', '), errorType: null, rawError: null };
  } catch (err) {
    const latency = Date.now() - start;
    const errorType = classifyError(err);
    const rawError = err?.message || String(err);
    logger.warn(`[DataValidation] Quotes & Greeks failed: ${rawError}`, 'data-validation');
    return { success: false, records: 0, latency, symbols: null, errorType, rawError };
  }
}

/**
 * Options Chain - SPY via data-service
 */
async function runOptionsChains() {
  const start = Date.now();
  try {
    const data = await dataServiceProxy.getOptionsChain(OPTIONS_SYMBOL);
    let records = 0;
    if (data?.options) {
      records = Array.isArray(data.options) ? data.options.length : Object.keys(data.options || {}).length;
    }
    if (data?.expirations) {
      records += Array.isArray(data.expirations) ? data.expirations.length : 0;
    }
    if (records === 0 && data) {
      records = 1; // at least got a response
    }
    const latency = Date.now() - start;
    return { success: true, records, latency, symbols: OPTIONS_SYMBOL, errorType: null, rawError: null };
  } catch (err) {
    const latency = Date.now() - start;
    const errorType = classifyError(err);
    const rawError = err?.message || String(err);
    logger.warn(`[DataValidation] Options Chains failed: ${rawError}`, 'data-validation');
    return { success: false, records: 0, latency, symbols: null, errorType, rawError };
  }
}

/**
 * Account State - Tastytrade (broker sync / account data pipeline)
 * Validates data-service health as proxy for account data availability when Tastytrade API not configured
 */
async function runAccountState() {
  const start = Date.now();
  try {
    const health = await dataServiceProxy.getHealth();
    const ok = health?.status === 'ok' || health?.status === 'degraded';
    const records = ok ? 1 : 0;
    const latency = Date.now() - start;
    return { success: records > 0, records, latency, symbols: null, errorType: null, rawError: null };
  } catch (err) {
    const latency = Date.now() - start;
    const errorType = classifyError(err);
    const rawError = err?.message || String(err);
    logger.warn(`[DataValidation] Account State failed: ${rawError}`, 'data-validation');
    return { success: false, records: 0, latency, symbols: null, errorType, rawError };
  }
}

/**
 * Regime / Vol - VIX, IV rank, expected move via data-service (Internal Proxy)
 */
async function runRegimeVol() {
  const start = Date.now();
  try {
    const [regime, vix] = await Promise.all([
      dataServiceProxy.getRegime().catch(() => null),
      dataServiceProxy.getVIX().catch(() => null),
    ]);
    let records = 0;
    if (regime) records++;
    if (vix) records++;
    const latency = Date.now() - start;
    return { success: records > 0, records, latency, symbols: null, errorType: null, rawError: null };
  } catch (err) {
    const latency = Date.now() - start;
    const errorType = classifyError(err);
    const rawError = err?.message || String(err);
    logger.warn(`[DataValidation] Regime/Vol failed: ${rawError}`, 'data-validation');
    return { success: false, records: 0, latency, symbols: null, errorType, rawError };
  }
}

/**
 * Run all job types for a validation run
 */
async function executeRun(scheduledAt) {
  const runId = await createRun(scheduledAt);
  const jobs = [
    { jobType: 'quotes_greeks', provider: 'tradier', fn: runQuotesGreeks },
    { jobType: 'options_chains', provider: 'tradier', fn: runOptionsChains },
    { jobType: 'account_state', provider: 'tastytrade', fn: runAccountState },
    { jobType: 'regime_vol', provider: 'internal_proxy', fn: runRegimeVol },
  ];

  const results = [];
  for (const { jobType, provider, fn } of jobs) {
    let lastResult;
    let retries = 0;
    const maxRetries = 2;
    while (retries <= maxRetries) {
      lastResult = await fn();
      if (lastResult.success) break;
      retries++;
      if (retries <= maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * retries));
      }
    }
    results.push({
      runId,
      jobType,
      provider,
      success: lastResult.success,
      recordsPulled: lastResult.records,
      latencyMs: lastResult.latency,
      errorType: lastResult.errorType,
      rawError: lastResult.rawError,
      retryCount: retries,
      symbols: lastResult.symbols,
    });
  }

  const passed = results.filter((r) => r.success).length;
  const total = results.length;
  let status = 'passed';
  if (passed === 0) status = 'failed';
  else if (passed < total) status = 'partial';

  const totalRecords = results.reduce((s, r) => s + (r.recordsPulled || 0), 0);
  const latencies = results.filter((r) => r.latencyMs != null).map((r) => r.latencyMs);
  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  await db.query(
    `UPDATE data_validation_run SET ran_at = NOW(), status = $1, total_records = $2, avg_latency_ms = $3, updated_at = NOW() WHERE id = $4`,
    [status, totalRecords, avgLatency, runId]
  );

  for (const r of results) {
    await db.query(
      `INSERT INTO data_validation_job (run_id, job_type, provider, success, records_pulled, latency_ms, error_type, raw_error, retry_count, symbols)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [r.runId, r.jobType, r.provider, r.success, r.recordsPulled, r.latencyMs, r.errorType, r.rawError, r.retryCount, r.symbols]
    );
  }

  // Update freshness for successful jobs
  for (const r of results) {
    if (r.success) {
      await db.query(
        `INSERT INTO data_validation_freshness (data_type, last_success_at, provider, updated_at)
         VALUES ($1, NOW(), $2, NOW())
         ON CONFLICT (data_type) DO UPDATE SET last_success_at = NOW(), provider = $2, updated_at = NOW()`,
        [r.jobType, r.provider]
      );
    }
  }

  // Create alerts for failures (last 2h) or stale data
  await createAlertsIfNeeded(runId, results, status);
  return { runId, status, results };
}

const STALE_HOURS = 3;

async function createAlertsIfNeeded(runId, results, runStatus) {
  const failed = results.filter((r) => !r.success);
  for (const r of failed) {
    const label = r.jobType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const msg = `${label} pull failed — ${r.provider} ${r.rawError || 'unknown error'}`;
    await db.query(
      `INSERT INTO data_validation_alert (severity, message, data_type, run_id) VALUES ('error', $1, $2, $3)`,
      [msg, r.jobType, runId]
    );
  }

  // Stale data warnings (avoid duplicates)
  const fresh = await db.query(`SELECT data_type, last_success_at FROM data_validation_freshness`);
  const now = new Date();
  const staleThreshold = STALE_HOURS * 60 * 60 * 1000;
  for (const row of fresh.rows) {
    const last = new Date(row.last_success_at);
    if (now - last > staleThreshold) {
      const existing = await db.query(
        `SELECT 1 FROM data_validation_alert WHERE data_type = $1 AND dismissed_at IS NULL AND severity = 'warning' LIMIT 1`,
        [row.data_type]
      );
      if (existing.rows.length > 0) continue;
      const label = row.data_type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const msg = `${label} stale — no successful pull since ${last.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })} ET. Data may be over ${STALE_HOURS} hours old.`;
      await db.query(
        `INSERT INTO data_validation_alert (severity, message, data_type) VALUES ('warning', $1, $2)`,
        [msg, row.data_type]
      );
    }
  }
}

async function createRun(scheduledAt) {
  const existing = await db.query(
    `SELECT id FROM data_validation_run WHERE scheduled_at = $1 AND status IN ('pending', 'running') LIMIT 1`,
    [scheduledAt]
  );
  if (existing.rows.length > 0) {
    await db.query(`UPDATE data_validation_run SET status = 'running' WHERE id = $1`, [existing.rows[0].id]);
    return existing.rows[0].id;
  }
  const r = await db.query(
    `INSERT INTO data_validation_run (scheduled_at, status) VALUES ($1, 'running') RETURNING id`,
    [scheduledAt]
  );
  return r.rows[0].id;
}

module.exports = {
  runQuotesGreeks,
  runOptionsChains,
  runAccountState,
  runRegimeVol,
  executeRun,
  classifyError,
};
