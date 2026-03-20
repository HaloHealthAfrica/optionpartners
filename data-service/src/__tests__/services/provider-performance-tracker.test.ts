import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderPerformanceTracker } from '../../services/provider-performance-tracker';
import type { ProviderName } from '../../types';

describe('ProviderPerformanceTracker', () => {
  let tracker: ProviderPerformanceTracker;

  beforeEach(() => {
    tracker = new ProviderPerformanceTracker();
  });

  describe('recordSuccess', () => {
    it('should record successful request', () => {
      tracker.recordSuccess('twelvedata', 100);
      const metrics = tracker.getMetrics('twelvedata');

      expect(metrics.successCount).toBe(1);
      expect(metrics.totalRequests).toBe(1);
      expect(metrics.successRate).toBe(100);
    });

    it('should record multiple successes', () => {
      tracker.recordSuccess('twelvedata', 100);
      tracker.recordSuccess('twelvedata', 150);
      tracker.recordSuccess('twelvedata', 120);

      const metrics = tracker.getMetrics('twelvedata');
      expect(metrics.successCount).toBe(3);
      expect(metrics.totalRequests).toBe(3);
      expect(metrics.successRate).toBe(100);
    });

    it('should track latency metrics', () => {
      tracker.recordSuccess('twelvedata', 50);
      tracker.recordSuccess('twelvedata', 100);
      tracker.recordSuccess('twelvedata', 150);

      const metrics = tracker.getMetrics('twelvedata');
      expect(metrics.minLatencyMs).toBe(50);
      expect(metrics.maxLatencyMs).toBe(150);
      expect(metrics.avgLatencyMs).toBe(100);
    });

    it('should update last success time', () => {
      const before = Date.now();
      tracker.recordSuccess('twelvedata', 100);
      const after = Date.now();

      const metrics = tracker.getMetrics('twelvedata');
      expect(metrics.lastSuccessAt).toBeGreaterThanOrEqual(before);
      expect(metrics.lastSuccessAt).toBeLessThanOrEqual(after);
    });
  });

  describe('recordFailure', () => {
    it('should record failed request', () => {
      tracker.recordFailure('twelvedata', 100);
      const metrics = tracker.getMetrics('twelvedata');

      expect(metrics.failureCount).toBe(1);
      expect(metrics.totalRequests).toBe(1);
      expect(metrics.successRate).toBe(0);
    });

    it('should calculate success rate correctly after mix of successes and failures', () => {
      tracker.recordSuccess('twelvedata', 100);
      tracker.recordSuccess('twelvedata', 100);
      tracker.recordSuccess('twelvedata', 100);
      tracker.recordFailure('twelvedata', 100);

      const metrics = tracker.getMetrics('twelvedata');
      expect(metrics.successCount).toBe(3);
      expect(metrics.failureCount).toBe(1);
      expect(metrics.totalRequests).toBe(4);
      expect(metrics.successRate).toBe(75);
    });

    it('should update last failure time', () => {
      const before = Date.now();
      tracker.recordFailure('twelvedata', 100);
      const after = Date.now();

      const metrics = tracker.getMetrics('twelvedata');
      expect(metrics.lastFailureAt).toBeGreaterThanOrEqual(before);
      expect(metrics.lastFailureAt).toBeLessThanOrEqual(after);
    });
  });

  describe('getMetrics', () => {
    it('should calculate reliability as excellent for 99%+ success', () => {
      // 99 successes, 1 failure
      for (let i = 0; i < 99; i++) {
        tracker.recordSuccess('twelvedata', 100);
      }
      tracker.recordFailure('twelvedata', 100);

      const metrics = tracker.getMetrics('twelvedata');
      expect(metrics.reliability).toBe('excellent');
    });

    it('should calculate reliability as good for 95-98% success', () => {
      // 95 successes, 5 failures
      for (let i = 0; i < 95; i++) {
        tracker.recordSuccess('twelvedata', 100);
      }
      for (let i = 0; i < 5; i++) {
        tracker.recordFailure('twelvedata', 100);
      }

      const metrics = tracker.getMetrics('twelvedata');
      expect(metrics.reliability).toBe('good');
    });

    it('should calculate reliability as fair for 80-94% success', () => {
      // 80 successes, 20 failures
      for (let i = 0; i < 80; i++) {
        tracker.recordSuccess('twelvedata', 100);
      }
      for (let i = 0; i < 20; i++) {
        tracker.recordFailure('twelvedata', 100);
      }

      const metrics = tracker.getMetrics('twelvedata');
      expect(metrics.reliability).toBe('fair');
    });

    it('should calculate reliability as poor below 80% success', () => {
      // 50 successes, 50 failures
      for (let i = 0; i < 50; i++) {
        tracker.recordSuccess('twelvedata', 100);
      }
      for (let i = 0; i < 50; i++) {
        tracker.recordFailure('twelvedata', 100);
      }

      const metrics = tracker.getMetrics('twelvedata');
      expect(metrics.reliability).toBe('poor');
    });

    it('should calculate p95 latency correctly', () => {
      // Add 100 samples with increasing latency
      for (let i = 0; i < 100; i++) {
        tracker.recordSuccess('twelvedata', i + 1);
      }

      const metrics = tracker.getMetrics('twelvedata');
      // p95 should be around 95th sample (95 + 1 = 96ms, at index 94)
      expect(metrics.p95LatencyMs).toBeCloseTo(96, 1);
    });
  });

  describe('getProvidersByPerformance', () => {
    beforeEach(() => {
      // Setup: twelvedata is excellent, polygon is good, unusual_whales is fair
      for (let i = 0; i < 99; i++) {
        tracker.recordSuccess('twelvedata', 50);
      }
      tracker.recordFailure('twelvedata', 100);

      for (let i = 0; i < 95; i++) {
        tracker.recordSuccess('polygon', 100);
      }
      for (let i = 0; i < 5; i++) {
        tracker.recordFailure('polygon', 100);
      }

      for (let i = 0; i < 80; i++) {
        tracker.recordSuccess('unusual_whales', 150);
      }
      for (let i = 0; i < 20; i++) {
        tracker.recordFailure('unusual_whales', 200);
      }
    });

    it('should sort by success rate first', () => {
      const sorted = tracker.getProvidersByPerformance(['twelvedata', 'polygon', 'unusual_whales']);
      expect(sorted[0]).toBe('twelvedata');
      expect(sorted[1]).toBe('polygon');
      expect(sorted[2]).toBe('unusual_whales');
    });

    it('should then sort by latency if success rates are equal', () => {
      tracker.reset();

      // Both at 100% but different latencies
      for (let i = 0; i < 10; i++) {
        tracker.recordSuccess('twelvedata', 50);
      }
      for (let i = 0; i < 10; i++) {
        tracker.recordSuccess('polygon', 100);
      }

      const sorted = tracker.getProvidersByPerformance(['twelvedata', 'polygon']);
      expect(sorted[0]).toBe('twelvedata'); // Lower latency
    });
  });

  describe('calculateProviderScore', () => {
    it('should return high score for excellent provider', () => {
      for (let i = 0; i < 100; i++) {
        tracker.recordSuccess('twelvedata', 10);
      }

      const score = tracker.calculateProviderScore('twelvedata');
      expect(score).toBeGreaterThan(75);
    });

    it('should return lower score for unreliable provider', () => {
      for (let i = 0; i < 20; i++) {
        tracker.recordSuccess('twelvedata', 500);
      }
      for (let i = 0; i < 80; i++) {
        tracker.recordFailure('twelvedata', 500);
      }

      const unreliableScore = tracker.calculateProviderScore('twelvedata');

      // Compare with excellent provider
      for (let i = 0; i < 100; i++) {
        tracker.recordSuccess('polygon', 50);
      }
      const excellentScore = tracker.calculateProviderScore('polygon');

      expect(unreliableScore).toBeLessThan(excellentScore);
    });

    it('should factor in recent success', () => {
      for (let i = 0; i < 10; i++) {
        tracker.recordSuccess('twelvedata', 100);
      }

      const scoreWithRecentSuccess = tracker.calculateProviderScore('twelvedata');

      // Wait a bit and record failure (simulate time passing)
      tracker.recordFailure('polygon', 100);

      const scoreAfterDelay = tracker.calculateProviderScore('twelvedata');
      // Score should be similar or better (no time passed in test)
      expect(scoreAfterDelay).toBeGreaterThanOrEqual(scoreWithRecentSuccess - 5);
    });
  });

  describe('getRecommendedFallbackOrder', () => {
    beforeEach(() => {
      // Setup different performance profiles
      for (let i = 0; i < 99; i++) {
        tracker.recordSuccess('twelvedata', 50);
      }
      tracker.recordFailure('twelvedata', 100);

      for (let i = 0; i < 95; i++) {
        tracker.recordSuccess('polygon', 100);
      }
      for (let i = 0; i < 5; i++) {
        tracker.recordFailure('polygon', 100);
      }

      for (let i = 0; i < 80; i++) {
        tracker.recordSuccess('cboe', 150);
      }
      for (let i = 0; i < 20; i++) {
        tracker.recordFailure('cboe', 200);
      }
    });

    it('should return providers sorted by score', () => {
      const fallbackOrder = tracker.getRecommendedFallbackOrder(['twelvedata', 'polygon', 'cboe']);
      
      expect(fallbackOrder[0]).toBe('twelvedata'); // Best score
      expect(fallbackOrder[fallbackOrder.length - 1]).toBe('cboe'); // Worst score
    });

    it('should include all providers', () => {
      const fallbackOrder = tracker.getRecommendedFallbackOrder(['twelvedata', 'polygon', 'cboe', 'fred']);
      expect(fallbackOrder).toHaveLength(4);
    });
  });

  describe('getAllMetrics', () => {
    it('should return metrics for all providers', () => {
      tracker.recordSuccess('twelvedata', 100);
      tracker.recordSuccess('polygon', 100);
      tracker.recordSuccess('cboe', 100);

      const allMetrics = tracker.getAllMetrics();
      expect(allMetrics.length).toBe(7); // All providers
      expect(allMetrics.some((m) => m.provider === 'twelvedata')).toBe(true);
      expect(allMetrics.some((m) => m.provider === 'polygon')).toBe(true);
    });

    it('should show zero metrics for unused providers', () => {
      tracker.recordSuccess('twelvedata', 100);

      const allMetrics = tracker.getAllMetrics();
      const polygonMetrics = allMetrics.find((m) => m.provider === 'polygon');

      expect(polygonMetrics?.successCount).toBe(0);
      expect(polygonMetrics?.failureCount).toBe(0);
      expect(polygonMetrics?.totalRequests).toBe(0);
    });
  });

  describe('reset', () => {
    it('should reset all metrics', () => {
      tracker.recordSuccess('twelvedata', 100);
      tracker.recordFailure('polygon', 100);

      tracker.reset();

      const twelvedataMetrics = tracker.getMetrics('twelvedata');
      const polygonMetrics = tracker.getMetrics('polygon');

      expect(twelvedataMetrics.successCount).toBe(0);
      expect(polygonMetrics.failureCount).toBe(0);
    });

    it('should reset specific provider', () => {
      tracker.recordSuccess('twelvedata', 100);
      tracker.recordSuccess('polygon', 100);

      tracker.resetProvider('twelvedata');

      const twelvedataMetrics = tracker.getMetrics('twelvedata');
      const polygonMetrics = tracker.getMetrics('polygon');

      expect(twelvedataMetrics.successCount).toBe(0);
      expect(polygonMetrics.successCount).toBe(1); // Unchanged
    });
  });

  describe('getReliabilityReport', () => {
    it('should generate a report', () => {
      tracker.recordSuccess('twelvedata', 100);
      tracker.recordFailure('polygon', 100);

      const report = tracker.getReliabilityReport();

      expect(report).toContain('Provider Performance Report');
      expect(report).toContain('twelvedata');
      expect(report).toContain('polygon');
      expect(report).toContain('Success Rate');
      expect(report).toContain('Latency');
    });

    it('should show providers sorted by success rate', () => {
      for (let i = 0; i < 100; i++) {
        tracker.recordSuccess('twelvedata', 100);
      }

      for (let i = 0; i < 50; i++) {
        tracker.recordSuccess('polygon', 100);
      }
      for (let i = 0; i < 50; i++) {
        tracker.recordFailure('polygon', 100);
      }

      const report = tracker.getReliabilityReport();
      const twelvedataIndex = report.indexOf('twelvedata');
      const polygonIndex = report.indexOf('polygon');

      expect(twelvedataIndex).toBeLessThan(polygonIndex);
    });
  });
});
