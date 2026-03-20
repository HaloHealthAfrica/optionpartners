/**
 * Circuit breaker removed from data-service.
 * Replaced with no-op stub for backward compatibility with routes and v1 API.
 * Orchestrator fallback + rate limiting handle provider failures.
 */
import type { ProviderName } from '../types';

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  halfOpenAttempts: number;
}

export class CircuitBreaker {
  configure(_provider: ProviderName, _config?: unknown): void {
    // no-op
  }

  canExecute(_provider: ProviderName): boolean {
    return true;
  }

  recordSuccess(_provider: ProviderName): void {
    // no-op
  }

  recordFailure(_provider: ProviderName): void {
    // no-op
  }

  getState(_provider: ProviderName): CircuitState {
    return 'closed';
  }

  getStats(_provider: ProviderName): CircuitStats | null {
    return null;
  }

  getConsecutiveFailures(_provider: ProviderName): number {
    return 0;
  }

  setLongBackoff(_provider: ProviderName, _durationMs: number): void {
    // no-op
  }

  reset(_provider: ProviderName): void {
    // no-op
  }

  resetAll(): void {
    // no-op
  }

  getAllStates(): Map<ProviderName, CircuitStats> {
    return new Map();
  }
}

export const circuitBreaker = new CircuitBreaker();
