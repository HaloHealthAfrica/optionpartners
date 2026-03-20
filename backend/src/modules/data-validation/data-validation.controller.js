/**
 * Data Provider Validation - API Controller
 */

const db = require('../../config/database');
const dataValidationScheduler = require('./data-validation-scheduler');

const STALE_THRESHOLD_HOURS = 3;
const FAILURE_ALERT_WINDOW_HOURS = 2;

/** Format time in ET */
function formatET(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }) + ' ET';
}

/** Get freshness strip data */
async function getFreshness(req, res) {
  try {
    const r = await db.query(
      `SELECT data_type, last_success_at, provider, updated_at FROM data_validation_freshness`
    );
    const rows = r.rows;
    const now = new Date();
    const staleThreshold = STALE_THRESHOLD_HOURS * 60 * 60 * 1000;

    const freshness = [
      { dataType: 'quotes_greeks', label: 'Quotes & Greeks', lastSuccessAt: null, provider: null, stale: false },
      { dataType: 'options_chains', label: 'Options Chains', lastSuccessAt: null, provider: null, stale: false },
      { dataType: 'account_state', label: 'Account State', lastSuccessAt: null, provider: null, stale: false },
      { dataType: 'regime_vol', label: 'Regime / Vol Data', lastSuccessAt: null, provider: null, stale: false },
    ];

    for (const row of rows) {
      const f = freshness.find((x) => x.dataType === row.data_type);
      if (f) {
        f.lastSuccessAt = row.last_success_at;
        f.provider = row.provider;
        f.stale = row.last_success_at ? (now - new Date(row.last_success_at)) > staleThreshold : true;
      }
    }
    res.json(freshness);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Get today's runs */
async function getTodayRuns(req, res) {
  try {
    const { status, provider } = req.query;
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
    const today = formatter.format(new Date());

    let sql = `
      SELECT r.id, r.scheduled_at, r.ran_at, r.status, r.total_records, r.avg_latency_ms, r.created_at
      FROM data_validation_run r
      WHERE DATE(r.scheduled_at AT TIME ZONE 'America/New_York') = $1::date
      ORDER BY r.scheduled_at ASC
    `;
    const params = [today];
    const runsResult = await db.query(sql, params);
    let runs = runsResult.rows;

    if (status && status !== 'all') {
      runs = runs.filter((r) => r.status === status);
    }

    const runIds = runs.map((r) => r.id);
    if (runIds.length === 0) {
      return res.json({ runs: [], runIds: [] });
    }

    let jobsSql = `SELECT * FROM data_validation_job WHERE run_id = ANY($1) ORDER BY run_id, job_type`;
    const jobsResult = await db.query(jobsSql, [runIds]);
    const jobsByRun = {};
    for (const j of jobsResult.rows) {
      if (!jobsByRun[j.run_id]) jobsByRun[j.run_id] = [];
      jobsByRun[j.run_id].push(j);
    }

    if (provider && provider !== 'all') {
      runs = runs.filter((r) => {
        const jobs = jobsByRun[r.id] || [];
        return jobs.some((j) => j.provider === provider);
      });
    }

    const out = runs.map((r) => ({
      id: r.id,
      scheduledAt: r.scheduled_at,
      ranAt: r.ran_at,
      status: r.status,
      totalRecords: r.total_records,
      avgLatencyMs: r.avg_latency_ms,
      jobs: (jobsByRun[r.id] || []).map((j) => ({
        id: j.id,
        jobType: j.job_type,
        provider: j.provider,
        success: j.success,
        recordsPulled: j.records_pulled,
        latencyMs: j.latency_ms,
        errorType: j.error_type,
        rawError: j.raw_error,
        retryCount: j.retry_count,
        symbols: j.symbols,
      })),
    }));
    res.json({ runs: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Get 7-day heatmap and provider reliability */
async function getHistoryHeatmap(req, res) {
  try {
    const runsResult = await db.query(`
      SELECT r.id, r.scheduled_at, r.ran_at, r.status
      FROM data_validation_run r
      WHERE r.scheduled_at >= NOW() - interval '7 days'
      ORDER BY r.scheduled_at ASC
    `);

    const jobsResult = await db.query(`
      SELECT j.run_id, j.provider, j.success
      FROM data_validation_job j
      JOIN data_validation_run r ON r.id = j.run_id
      WHERE r.scheduled_at >= NOW() - interval '7 days'
    `);

    const jobsByRun = {};
    for (const j of jobsResult.rows) {
      if (!jobsByRun[j.run_id]) jobsByRun[j.run_id] = [];
      jobsByRun[j.run_id].push(j);
    }

    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    const heatmap = {};
    const providerStats = { tradier: { pass: 0, partial: 0, fail: 0 }, tastytrade: { pass: 0, partial: 0, fail: 0 }, internal_proxy: { pass: 0, partial: 0, fail: 0 } };

    for (const r of runsResult.rows) {
      const d = new Date(r.scheduled_at);
      const day = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const key = `${day}_${time}`;
      heatmap[key] = { status: r.status, runId: r.id };

      const jobs = jobsByRun[r.id] || [];
      for (const p of ['tradier', 'tastytrade', 'internal_proxy']) {
        const pJobs = jobs.filter((j) => j.provider === p);
        if (pJobs.length === 0) continue;
        const allPass = pJobs.every((j) => j.success);
        const anyPass = pJobs.some((j) => j.success);
        if (allPass) providerStats[p].pass++;
        else if (anyPass) providerStats[p].partial++;
        else providerStats[p].fail++;
      }
    }

    const reliability = Object.entries(providerStats).map(([name, s]) => {
      const total = s.pass + s.partial + s.fail;
      const pct = total > 0 ? Math.round((s.pass / total) * 100) : 100;
      return { provider: name, pass: s.pass, partial: s.partial, fail: s.fail, total, passRate: pct };
    });

    res.json({ heatmap: runsResult.rows, reliability });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Get alerts */
async function getAlerts(req, res) {
  try {
    const r = await db.query(`
      SELECT id, severity, message, data_type, run_id, triggered_at, dismissed_at
      FROM data_validation_alert
      WHERE dismissed_at IS NULL
      ORDER BY triggered_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Dismiss alert */
async function dismissAlert(req, res) {
  try {
    const { id } = req.params;
    await db.query(`UPDATE data_validation_alert SET dismissed_at = NOW() WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Manual run now */
async function runNow(req, res) {
  try {
    const { runId } = req.body;
    let scheduledAt;
    if (runId) {
      const r = await db.query(`SELECT scheduled_at FROM data_validation_run WHERE id = $1`, [runId]);
      if (r.rows.length === 0) return res.status(404).json({ error: 'Run not found' });
      scheduledAt = r.rows[0].scheduled_at;
    } else {
      scheduledAt = new Date();
    }
    const result = await dataValidationScheduler.executeRun(scheduledAt);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Ensure today's slots exist (for UI bootstrap) */
async function ensureSlots(req, res) {
  try {
    await dataValidationScheduler.ensureTodaySlots();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getFreshness,
  getTodayRuns,
  getHistoryHeatmap,
  getAlerts,
  dismissAlert,
  runNow,
  ensureSlots,
};
