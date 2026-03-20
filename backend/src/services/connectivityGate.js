'use strict';

const logger = require('../utils/logger');

/**
 * Connectivity Gate — replaces the old circuit breaker.
 *
 * Design:
 * - Health-check driven: only the background probe affects state (not every request)
 * - Fail-open until 3+ consecutive probe failures → then fail-fast (UNHEALTHY)
 * - No persistence: restart = fresh HEALTHY state
 * - Manual reset always works
 *
 * States: HEALTHY | DEGRADED | UNHEALTHY
 * - HEALTHY: all requests allowed
 * - DEGRADED: all requests allowed (1–2 probe failures, transient)
 * - UNHEALTHY: fail-fast, block requests until probe succeeds or manual reset
 */
const CONSECUTIVE_FAILURES_THRESHOLD = parseInt(process.env.CONNECTIVITY_GATE_FAILURE_THRESHOLD || '3', 10);
const PROBE_INTERVAL_MS = parseInt(process.env.CONNECTIVITY_GATE_PROBE_MS || '30000', 10);

const gate = {
  state: 'HEALTHY',
  consecutiveFailures: 0,
  lastCheckAt: null,
  lastSuccessAt: null,
  _intervalId: null,

  canRequest() {
    return this.state !== 'UNHEALTHY';
  },

  recordProbeSuccess() {
    const was = this.state;
    this.consecutiveFailures = 0;
    this.state = 'HEALTHY';
    this.lastSuccessAt = Date.now();
    this.lastCheckAt = this.lastSuccessAt;
    if (was !== 'HEALTHY') {
      logger.info(`[ConnectivityGate] HEALTHY — probe succeeded (was ${was})`, 'connectivity-gate');
      if (this._onRecovery && typeof this._onRecovery === 'function') {
        this._onRecovery().catch((err) => logger.warn(`[ConnectivityGate] onRecovery failed: ${err.message}`, 'connectivity-gate'));
      }
    }
  },

  recordProbeFailure() {
    this.consecutiveFailures++;
    this.lastCheckAt = Date.now();

    if (this.consecutiveFailures >= CONSECUTIVE_FAILURES_THRESHOLD) {
      this.state = 'UNHEALTHY';
      logger.warn(
        `[ConnectivityGate] UNHEALTHY — ${this.consecutiveFailures} consecutive probe failures. Blocking requests until recovery.`,
        'connectivity-gate'
      );
    } else {
      this.state = 'DEGRADED';
      logger.warn(
        `[ConnectivityGate] DEGRADED — ${this.consecutiveFailures}/${CONSECUTIVE_FAILURES_THRESHOLD} probe failures (requests still allowed)`,
        'connectivity-gate'
      );
    }
  },

  reset() {
    const was = this.state;
    this.state = 'HEALTHY';
    this.consecutiveFailures = 0;
    this.lastSuccessAt = Date.now();
    this.lastCheckAt = this.lastSuccessAt;
    logger.info(`[ConnectivityGate] Manual reset → HEALTHY (was ${was})`, 'connectivity-gate');
  },

  getState() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckAt: this.lastCheckAt,
      lastSuccessAt: this.lastSuccessAt,
    };
  },

  onRecovery(fn) {
    this._onRecovery = fn;
  },

  /**
   * Start background health probe. Call probeFn every PROBE_INTERVAL_MS.
   * probeFn should return Promise<{ ok: boolean, error?: string }>
   */
  startProbe(probeFn) {
    if (this._intervalId) return;

    const run = async () => {
      try {
        const result = await probeFn();
        if (result.ok) {
          this.recordProbeSuccess();
        } else {
          this.recordProbeFailure();
        }
      } catch (err) {
        this.recordProbeFailure();
        logger.warn(`[ConnectivityGate] Probe error: ${err.message}`, 'connectivity-gate');
      }
    };

    this._intervalId = setInterval(run, PROBE_INTERVAL_MS);
    run(); // run immediately
    logger.info(`[ConnectivityGate] Probe started (interval=${PROBE_INTERVAL_MS}ms)`, 'connectivity-gate');
  },

  stopProbe() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
      logger.info('[ConnectivityGate] Probe stopped', 'connectivity-gate');
    }
  },
};

module.exports = gate;
