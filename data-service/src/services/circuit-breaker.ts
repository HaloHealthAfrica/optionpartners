import { createChildLogger } from '../utils/logger';
import type { ProviderName } from '../types';

const log = createChildLogger('circuit-breaker');

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
}

interface CircuitStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  halfOpenAttempts: number;
}

const DEFAULT_CONFIG: CircuitConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 2,
};

export class CircuitBreaker {
  private circuits = new Map<ProviderName, CircuitStats>();
  private configs = new Map<ProviderName, CircuitConfig>();

  configure(provider: ProviderName, config?: Partial<CircuitConfig>): void {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.configs.set(provider, cfg);
    this.circuits.set(provider, {
      state: 'closed',
      failures: 0,
      successes: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
      halfOpenAttempts: 0,
    });
    log.info({ provider, config: cfg }, 'Circuit breaker configured');
  }

  canExecute(provider: ProviderName): boolean {
    const stats = this.circuits.get(provider);
    const cfg = this.configs.get(provider);
    if (!stats || !cfg) return true;

    if (stats.state === 'closed') return true;

    if (stats.state === 'open') {
      if (stats.lastFailureTime && Date.now() - stats.lastFailureTime >= cfg.resetTimeoutMs) {
        const oldState = stats.state;
        stats.state = 'half-open';
        stats.halfOpenAttempts = 0;
        log.info({ provider, transition: `${oldState} → half-open` }, 'Circuit breaker state transition: OPEN → HALF_OPEN');
        return true;
      }
      return false;
    }

    // half-open: allow limited attempts
    return stats.halfOpenAttempts < cfg.halfOpenMaxAttempts;
  }

  recordSuccess(provider: ProviderName): void {
    const stats = this.circuits.get(provider);
    if (!stats) return;

    stats.successes++;
    stats.lastSuccessTime = Date.now();
    stats.failures = 0;

    if (stats.state === 'half-open') {
      const oldState = stats.state;
      stats.state = 'closed';
      stats.halfOpenAttempts = 0;
      log.info({ provider, transition: `${oldState} → closed` }, 'Circuit breaker state transition: HALF_OPEN → CLOSED');
    }
  }

  recordFailure(provider: ProviderName): void {
    const stats = this.circuits.get(provider);
    const cfg = this.configs.get(provider);
    if (!stats || !cfg) return;

    stats.failures++;
    stats.lastFailureTime = Date.now();

    if (stats.state === 'half-open') {
      stats.halfOpenAttempts++;
      if (stats.halfOpenAttempts >= cfg.halfOpenMaxAttempts) {
        const oldState = stats.state;
        stats.state = 'open';
        log.warn({ provider, transition: `${oldState} → open` }, 'Circuit breaker state transition: HALF_OPEN → OPEN (re-opened after half-open failures)');
      }
      return;
    }

    if (stats.failures >= cfg.failureThreshold) {
      const oldState = stats.state;
      stats.state = 'open';
      log.warn({ provider, failures: stats.failures, transition: `${oldState} → open` }, 'Circuit breaker state transition: CLOSED → OPEN');
    }
  }

  getState(provider: ProviderName): CircuitState {
    const stats = this.circuits.get(provider);
    if (!stats) return 'closed';

    // Recheck in case timeout has passed
    if (stats.state === 'open') {
      const cfg = this.configs.get(provider);
      if (cfg && stats.lastFailureTime && Date.now() - stats.lastFailureTime >= cfg.resetTimeoutMs) {
        stats.state = 'half-open';
        stats.halfOpenAttempts = 0;
      }
    }

    return stats.state;
  }

  getStats(provider: ProviderName): CircuitStats | null {
    return this.circuits.get(provider) ?? null;
  }

  getConsecutiveFailures(provider: ProviderName): number {
    return this.circuits.get(provider)?.failures ?? 0;
  }

  setLongBackoff(provider: ProviderName, durationMs: number): void {
    const stats = this.circuits.get(provider);
    if (stats) {
      stats.state = 'open';
      stats.lastFailureTime = Date.now() + durationMs - (this.configs.get(provider)?.resetTimeoutMs ?? 30_000);
      log.warn({ provider, durationMs }, 'Long backoff set — circuit breaker locked open');
    }
  }

  reset(provider: ProviderName): void {
    const stats = this.circuits.get(provider);
    if (stats) {
      const oldState = stats.state;
      stats.state = 'closed';
      stats.failures = 0;
      stats.halfOpenAttempts = 0;
      log.info({ provider, transition: `${oldState} → closed` }, 'Circuit breaker manually reset');
    }
  }

  resetAll(): void {
    for (const provider of this.circuits.keys()) {
      this.reset(provider);
    }
    log.info('All circuit breakers manually reset');
  }

  getAllStates(): Map<ProviderName, CircuitStats> {
    return new Map(this.circuits);
  }
}

export const circuitBreaker = new CircuitBreaker();
