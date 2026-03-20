import { createChildLogger } from '../utils/logger';
import type { ProviderName } from '../types';

const log = createChildLogger('provider-performance');

export interface ProviderPerformanceMetrics {
  provider: ProviderName;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  p95LatencyMs: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  reliability: 'excellent' | 'good' | 'fair' | 'poor';
}

interface LatencySample {
  timestamp: number;
  latencyMs: number;
}

export class ProviderPerformanceTracker {
  private successCounts = new Map<ProviderName, number>();
  private failureCounts = new Map<ProviderName, number>();
  private latencySamples = new Map<ProviderName, LatencySample[]>();
  private lastSuccessTimes = new Map<ProviderName, number>();
  private lastFailureTimes = new Map<ProviderName, number>();
  private maxSamples = 1000; // Keep last 1000 latency samples per provider

  /**
   * Record a successful request
   */
  recordSuccess(provider: ProviderName, latencyMs: number): void {
    this.successCounts.set(provider, (this.successCounts.get(provider) ?? 0) + 1);
    this.lastSuccessTimes.set(provider, Date.now());

    // Track latency
    const samples = this.latencySamples.get(provider) ?? [];
    samples.push({ timestamp: Date.now(), latencyMs });

    // Keep only recent samples
    if (samples.length > this.maxSamples) {
      samples.shift();
    }

    this.latencySamples.set(provider, samples);
  }

  /**
   * Record a failed request
   */
  recordFailure(provider: ProviderName, latencyMs: number): void {
    this.failureCounts.set(provider, (this.failureCounts.get(provider) ?? 0) + 1);
    this.lastFailureTimes.set(provider, Date.now());

    // Still track latency of failed requests
    const samples = this.latencySamples.get(provider) ?? [];
    samples.push({ timestamp: Date.now(), latencyMs });

    if (samples.length > this.maxSamples) {
      samples.shift();
    }

    this.latencySamples.set(provider, samples);
  }

  /**
   * Get performance metrics for a specific provider
   */
  getMetrics(provider: ProviderName): ProviderPerformanceMetrics {
    const successCount = this.successCounts.get(provider) ?? 0;
    const failureCount = this.failureCounts.get(provider) ?? 0;
    const totalRequests = successCount + failureCount;

    const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0;
    const samples = this.latencySamples.get(provider) ?? [];

    // Calculate latency statistics
    const avgLatencyMs = samples.length > 0 ? samples.reduce((sum, s) => sum + s.latencyMs, 0) / samples.length : 0;
    const minLatencyMs = samples.length > 0 ? Math.min(...samples.map(s => s.latencyMs)) : 0;
    const maxLatencyMs = samples.length > 0 ? Math.max(...samples.map(s => s.latencyMs)) : 0;

    // Calculate p95 latency (95th percentile)
    let p95LatencyMs = 0;
    if (samples.length > 0) {
      const sorted = [...samples].sort((a, b) => a.latencyMs - b.latencyMs);
      const index = Math.floor(sorted.length * 0.95);
      p95LatencyMs = sorted[index].latencyMs;
    }

    // Determine reliability rating
    let reliability: ProviderPerformanceMetrics['reliability'] = 'excellent';
    if (successRate >= 99) {
      reliability = 'excellent';
    } else if (successRate >= 95) {
      reliability = 'good';
    } else if (successRate >= 80) {
      reliability = 'fair';
    } else {
      reliability = 'poor';
    }

    return {
      provider,
      totalRequests,
      successCount,
      failureCount,
      successRate,
      avgLatencyMs,
      minLatencyMs,
      maxLatencyMs,
      p95LatencyMs,
      lastSuccessAt: this.lastSuccessTimes.get(provider),
      lastFailureAt: this.lastFailureTimes.get(provider),
      reliability,
    };
  }

  /**
   * Get performance metrics for all providers
   */
  getAllMetrics(): ProviderPerformanceMetrics[] {
    const providers: ProviderName[] = ['twelvedata', 'unusual_whales', 'polygon', 'cboe', 'fred', 'marketdata', 'computed'];
    return providers.map((provider) => this.getMetrics(provider));
  }

  /**
   * Get providers sorted by performance (best first)
   * Considers success rate and latency
   */
  getProvidersByPerformance(providers: ProviderName[]): ProviderName[] {
    const metrics = providers.map((p) => this.getMetrics(p));

    // Sort by: success rate (descending), then avg latency (ascending)
    return metrics
      .sort((a, b) => {
        // Primary: success rate (higher is better)
        if (a.successRate !== b.successRate) {
          return b.successRate - a.successRate;
        }

        // Secondary: average latency (lower is better)
        if (a.avgLatencyMs !== b.avgLatencyMs) {
          return a.avgLatencyMs - b.avgLatencyMs;
        }

        // Tertiary: most recent success (newer is better)
        const aSuccess = a.lastSuccessAt ?? 0;
        const bSuccess = b.lastSuccessAt ?? 0;
        return bSuccess - aSuccess;
      })
      .map((m) => m.provider);
  }

  /**
   * Calculate a provider score (0-100) for adaptive fallback selection
   * Higher score = should try first
   */
  calculateProviderScore(provider: ProviderName): number {
    const metrics = this.getMetrics(provider);

    // Base score from success rate (0-50 points)
    const successScore = (metrics.successRate / 100) * 50;

    // Latency score (0-30 points) - lower is better
    const latencyScore = Math.max(0, 30 - (metrics.avgLatencyMs / 100)); // 100ms = 0 points

    // Recency score (0-20 points) - recent success is better
    const lastSuccess = metrics.lastSuccessAt ?? 0;
    const timeSinceSuccess = Math.max(0, Date.now() - lastSuccess);
    const recencyScore = Math.max(0, 20 - (timeSinceSuccess / 60000)); // 1 minute = 0 points

    return Math.round(successScore + latencyScore + recencyScore);
  }

  /**
   * Get recommended fallback order based on performance
   */
  getRecommendedFallbackOrder(providers: ProviderName[]): ProviderName[] {
    return providers
      .map((p) => ({ provider: p, score: this.calculateProviderScore(p) }))
      .sort((a, b) => b.score - a.score)
      .map((item) => item.provider);
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.successCounts.clear();
    this.failureCounts.clear();
    this.latencySamples.clear();
    this.lastSuccessTimes.clear();
    this.lastFailureTimes.clear();
    log.info('All provider performance metrics reset');
  }

  /**
   * Reset metrics for a specific provider
   */
  resetProvider(provider: ProviderName): void {
    this.successCounts.delete(provider);
    this.failureCounts.delete(provider);
    this.latencySamples.delete(provider);
    this.lastSuccessTimes.delete(provider);
    this.lastFailureTimes.delete(provider);
    log.info({ provider }, 'Provider performance metrics reset');
  }

  /**
   * Get a reliability report for debugging
   */
  getReliabilityReport(): string {
    const metrics = this.getAllMetrics();
    const sorted = metrics.sort((a, b) => b.successRate - a.successRate);

    let report = 'Provider Performance Report\n';
    report += '============================\n\n';

    for (const metric of sorted) {
      report += `${metric.provider}:\n`;
      report += `  Success Rate: ${metric.successRate.toFixed(2)}% (${metric.successCount}/${metric.totalRequests})\n`;
      report += `  Latency: avg=${metric.avgLatencyMs.toFixed(0)}ms, p95=${metric.p95LatencyMs.toFixed(0)}ms, max=${metric.maxLatencyMs.toFixed(0)}ms\n`;
      report += `  Reliability: ${metric.reliability}\n`;
      report += `  Last Success: ${metric.lastSuccessAt ? new Date(metric.lastSuccessAt).toISOString() : 'Never'}\n`;
      report += `  Last Failure: ${metric.lastFailureAt ? new Date(metric.lastFailureAt).toISOString() : 'Never'}\n\n`;
    }

    return report;
  }

  /**
   * Log reliability report
   */
  logReliabilityReport(): void {
    const report = this.getReliabilityReport();
    log.info({ report }, 'Provider reliability report');
  }
}

export const performanceTracker = new ProviderPerformanceTracker();
