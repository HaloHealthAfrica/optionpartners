import { createChildLogger } from '../utils/logger';
import { rateLimiter } from './rate-limiter';
import { performanceTracker } from './provider-performance-tracker';
import { loadBalancer } from './load-balancer';
import type { ProviderName } from '../types';

const log = createChildLogger('monitoring');

export interface CircuitBreakerMetric {
  provider: ProviderName;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  successes: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  healthy: boolean;
}

export interface RateLimiterMetric {
  provider: ProviderName;
  configured: boolean;
  maxTokens?: number;
  remaining?: number;
  refillRate?: number;
  healthy: boolean;
  errorMessage?: string;
}

export interface MonitoringMetrics {
  timestamp: string;
  uptime: number;
  circuitBreakers: CircuitBreakerMetric[];
  rateLimiters: RateLimiterMetric[];
  summary: {
    totalProviders: number;
    circuitBreakersClosed: number;
    circuitBreakersOpen: number;
    circuitBreakersHalfOpen: number;
    rateLimitersHealthy: number;
    rateLimitersDegraded: number;
  };
}

export class MonitoringService {
  /**
   * Get detailed circuit breaker metrics for all providers.
   * Circuit breaker removed — returns empty array for backward compatibility.
   */
  getCircuitBreakerMetrics(): CircuitBreakerMetric[] {
    return [];
  }

  /**
   * Get detailed rate limiter metrics for all providers
   */
  getRateLimiterMetrics(): RateLimiterMetric[] {
    const providers: ProviderName[] = [
      'twelvedata',
      'unusual_whales',
      'polygon',
      'cboe',
      'fred',
      'marketdata',
      'computed',
    ];

    return providers
      .map((provider) => rateLimiter.getStatus(provider))
      .filter((status) => status.configured); // Only return configured providers
  }

  /**
   * Get comprehensive monitoring metrics (circuit breakers + rate limiters + summary)
   */
  getMetrics(): MonitoringMetrics {
    const circuitBreakerMetrics = this.getCircuitBreakerMetrics();
    const rateLimiterMetrics = this.getRateLimiterMetrics();

    const circuitBreakersClosed = 0;
    const circuitBreakersOpen = 0;
    const circuitBreakersHalfOpen = 0;

    const rateLimitersHealthy = rateLimiterMetrics.filter(
      (m) => m.healthy
    ).length;

    const rateLimitersDegraded = rateLimiterMetrics.filter(
      (m) => !m.healthy && m.configured
    ).length;

    return {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      circuitBreakers: circuitBreakerMetrics,
      rateLimiters: rateLimiterMetrics,
      summary: {
        totalProviders: rateLimiterMetrics.length,
        circuitBreakersClosed,
        circuitBreakersOpen,
        circuitBreakersHalfOpen,
        rateLimitersHealthy,
        rateLimitersDegraded,
      },
    };
  }

  /**
   * Get health status summary
   */
  getHealthStatus(): { status: 'healthy' | 'degraded' | 'critical'; details: string } {
    const metrics = this.getMetrics();
    const { rateLimitersDegraded } = metrics.summary;

    if (rateLimitersDegraded > 0) {
      return {
        status: 'degraded',
        details: `${rateLimitersDegraded} rate limiter(s) degraded`,
      };
    }

    return {
      status: 'healthy',
      details: 'All rate limiters healthy',
    };
  }

  /**
   * Check if all critical providers are healthy
   */
  areAllProvidersHealthy(): boolean {
    const metrics = this.getMetrics();
    return metrics.summary.rateLimitersDegraded === 0;
  }

  /**
   * Get circuit breaker health for specific provider
   */
  getProviderCircuitBreakerHealth(provider: ProviderName): CircuitBreakerMetric | null {
    const metrics = this.getCircuitBreakerMetrics();
    return metrics.find((m) => m.provider === provider) ?? null;
  }

  /**
   * Get rate limiter health for specific provider
   */
  getProviderRateLimiterHealth(provider: ProviderName): RateLimiterMetric | null {
    const metrics = this.getRateLimiterMetrics();
    return metrics.find((m) => m.provider === provider) ?? null;
  }

  /**
   * Get overall provider health (combined circuit breaker + rate limiter status)
   */
  getProviderHealth(provider: ProviderName): {
    provider: ProviderName;
    healthy: boolean;
    circuitBreaker: CircuitBreakerMetric | null;
    rateLimiter: RateLimiterMetric | null;
  } {
    const rl = this.getProviderRateLimiterHealth(provider);
    const healthy = rl?.healthy ?? true;
    return { provider, healthy, circuitBreaker: null, rateLimiter: rl };
  }

  /**
   * Log metrics for debugging
   */
  logMetrics(): void {
    const metrics = this.getMetrics();
    log.info(
      {
        timestamp: metrics.timestamp,
        uptime: metrics.uptime,
        summary: metrics.summary,
        circuitBreakers: metrics.circuitBreakers.map((m) => ({
          provider: m.provider,
          state: m.state,
          failures: m.failures,
        })),
        rateLimiters: metrics.rateLimiters.map((m) => ({
          provider: m.provider,
          remaining: m.remaining,
          maxTokens: m.maxTokens,
        })),
      },
      'Monitoring metrics snapshot'
    );
  }

  /**
   * Get provider performance metrics for all providers
   */
  getProviderPerformanceMetrics() {
    return performanceTracker.getAllMetrics();
  }

  /**
   * Get fallback metrics from orchestrator
   */
  getFallbackMetrics(orchestrator: any) {
    // `orchestrator` is passed in from index.ts where it's available
    return orchestrator.getFallbackMetrics ? orchestrator.getFallbackMetrics() : {};
  }

  /**
   * Get provider performance metrics for a specific provider
   */
  getProviderPerformance(provider: ProviderName) {
    return performanceTracker.getMetrics(provider);
  }

  /**
   * Return the currently configured load-balancing strategy
   */
  getLoadBalancerStrategy(): string {
    return loadBalancer.getStrategy();
  }

  /**
   * Get providers sorted by performance
   */
  getProvidersByPerformance(providers: ProviderName[]) {
    return performanceTracker.getProvidersByPerformance(providers);
  }

  /**
   * Get recommended fallback order for providers
   */
  getRecommendedFallbackOrder(providers: ProviderName[]) {
    return performanceTracker.getRecommendedFallbackOrder(providers);
  }

  /**
   * Get provider reliability report
   */
  getReliabilityReport(): string {
    return performanceTracker.getReliabilityReport();
  }
}

export const monitoringService = new MonitoringService();
