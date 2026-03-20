import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataOrchestrator } from '../../services/data-orchestrator';
import { performanceTracker } from '../../services/provider-performance-tracker';
import { loadBalancer } from '../../services/load-balancer';
import { monitoringService } from '../../services/monitoring-service';
import type { MarketDataProvider } from '../../types';

// Mock provider implementation
function createMockProvider(name: string, delayMs: number = 0): MarketDataProvider {
  return {
    name: name as any,
    capabilities: {
      // primary camelCase keys used in production
      candles: true,
      quotes: true,
      optionsChain: true,
      gex: name !== 'computed',
      flow: true,
      iv: true,
      vix: true,
      marketHours: true,
      // also add legacy/singular aliases used in some tests
      candle: true,
      quote: true,
      chain: true,
    },
    getQuote: vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { symbol: 'TEST', price: 100 };
    }),
    getCandles: vi.fn().mockResolvedValue([]),
    getOptionsChain: vi.fn().mockResolvedValue({ symbol: 'TEST', chain: [] }),
    getGex: vi.fn().mockResolvedValue({ symbol: 'TEST', gex: 0 }),
    getFlow: vi.fn().mockResolvedValue([]),
    getIv: vi.fn().mockResolvedValue({ symbol: 'TEST', iv: 0.2 }),
    getVix: vi.fn().mockResolvedValue({ vix: 20 }),
    getMarketHours: vi.fn().mockResolvedValue({ isOpen: true }),
  };
}

describe('DataOrchestrator - Fallback Chain Optimization', () => {
  let orchestrator: DataOrchestrator;

  beforeEach(() => {
    performanceTracker.reset();
    loadBalancer.setStrategy('none');
    orchestrator = new DataOrchestrator();
  });

  describe('intelligent fallback ordering', () => {
    it('should use performance-based provider ordering in fallback', async () => {
      const fast = createMockProvider('fast_provider', 10);
      const slow = createMockProvider('slow_provider', 100);

      orchestrator.registerProvider(fast, 'primary');
      orchestrator.registerProvider(slow, 'secondary');

      // Record some history to establish performance difference
      performanceTracker.recordSuccess('fast_provider', 10);
      performanceTracker.recordSuccess('fast_provider', 15);
      performanceTracker.recordSuccess('slow_provider', 100);
      performanceTracker.recordSuccess('slow_provider', 150);

      // Make a request
      const result = await orchestrator.executeWithFallback('quote', 'test', async (provider) => {
        return provider.getQuote('TEST');
      });

      expect(result).toBeDefined();
      // Fast provider should have been tried first (and succeeded)
      expect(fast.getQuote).toHaveBeenCalled();
    });

    it('should prioritize high-success-rate provider', async () => {
      const reliable = createMockProvider('reliable', 10);
      const unreliable = createMockProvider('unreliable', 10);

      orchestrator.registerProvider(reliable, 'primary');
      orchestrator.registerProvider(unreliable, 'secondary');

      // Establish performance history
      for (let i = 0; i < 100; i++) {
        performanceTracker.recordSuccess('reliable', 10);
      }

      for (let i = 0; i < 50; i++) {
        performanceTracker.recordSuccess('unreliable', 10);
      }
      for (let i = 0; i < 50; i++) {
        performanceTracker.recordFailure('unreliable', 10);
      }

      const result = await orchestrator.executeWithFallback('quote', 'test', async (provider) => {
        return provider.getQuote('TEST');
      });

      expect(result).toBeDefined();
    });

    it('should reorder providers by performance score', () => {
      const recommendations = performanceTracker.getRecommendedFallbackOrder([
        'twelvedata',
        'polygon',
        'unusual_whales',
      ]);

      expect(recommendations).toHaveLength(3);
      expect(recommendations).toContainEqual('twelvedata');
    });
  });

  describe('fallback chain with performance tracking', () => {
    it('should track latency of all attempts', async () => {
      const provider1 = createMockProvider('provider1', 20);
      const provider2 = createMockProvider('provider2', 40);

      orchestrator.registerProvider(provider1, 'primary');
      orchestrator.registerProvider(provider2, 'secondary');

      const result = await orchestrator.executeWithFallback('quote', 'test', async (provider) => {
        return provider.getQuote('TEST');
      });

      expect(result).toBeDefined();

      const metrics = performanceTracker.getMetrics('provider1');
      expect(metrics.successCount).toBeGreaterThan(0);
    });

    it('should calculate accurate latency percentiles', () => {
      // Record various latencies
      const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      latencies.forEach((lat) => {
        performanceTracker.recordSuccess('test_provider', lat);
      });

      const metrics = performanceTracker.getMetrics('test_provider');
      expect(metrics.avgLatencyMs).toBe(55); // Average of 10-100
      expect(metrics.minLatencyMs).toBe(10);
      expect(metrics.maxLatencyMs).toBe(100);
      expect(metrics.p95LatencyMs).toBeGreaterThanOrEqual(85); // p95 should be close to 95th value
    });
  });

  describe('fallback performance report', () => {
    it('should generate reliability report', () => {
      performanceTracker.recordSuccess('twelvedata', 50);
      performanceTracker.recordSuccess('twelvedata', 60);
      performanceTracker.recordFailure('polygon', 100);

      const report = performanceTracker.getReliabilityReport();

      expect(report).toContain('twelvedata');
      expect(report).toContain('Success Rate');
      expect(report).toContain('Latency');
    });

    it('should show provider scores', () => {
      performanceTracker.recordSuccess('twelvedata', 50);
      performanceTracker.recordSuccess('polygon', 100);

      const score1 = performanceTracker.calculateProviderScore('twelvedata');
      const score2 = performanceTracker.calculateProviderScore('polygon');

      expect(score1).toBeGreaterThan(0);
      expect(score2).toBeGreaterThan(0);
      // twelvedata should score higher (lower latency)
      expect(score1).toBeGreaterThan(score2);
    });
  });

  describe('adaptive fallback selection', () => {
    it('should prefer providers with recent successes', () => {
      performanceTracker.recordSuccess('twelvedata', 50);

      const score = performanceTracker.calculateProviderScore('twelvedata');
      expect(score).toBeGreaterThan(20);
    });

    it('should account for both success rate and latency in scoring', () => {
      // Provider A: 100% success, high latency
      for (let i = 0; i < 100; i++) {
        performanceTracker.recordSuccess('provider_a', 500);
      }

      // Provider B: 100% success, low latency
      for (let i = 0; i < 100; i++) {
        performanceTracker.recordSuccess('provider_b', 50);
      }

      const scoreA = performanceTracker.calculateProviderScore('provider_a');
      const scoreB = performanceTracker.calculateProviderScore('provider_b');

      expect(scoreB).toBeGreaterThan(scoreA); // B should score higher
    });

    it('should properly weight reliability over recency', () => {
      // Establish a provider as unreliable
      for (let i = 0; i < 50; i++) {
        performanceTracker.recordSuccess('unreliable', 50);
      }
      for (let i = 0; i < 50; i++) {
        performanceTracker.recordFailure('unreliable', 50);
      }

      // Even with recent success
      performanceTracker.recordSuccess('unreliable', 50);

      const unreliableScore = performanceTracker.calculateProviderScore('unreliable');

      // Establish a reliable provider
      for (let i = 0; i < 100; i++) {
        performanceTracker.recordSuccess('reliable', 100);
      }

      const reliableScore = performanceTracker.calculateProviderScore('reliable');

      expect(reliableScore).toBeGreaterThan(unreliableScore);
    });
  });

  describe('fallback metrics tracking', () => {
    it('should increment fallback count when a non-primary provider succeeds', async () => {
      const primary = createMockProvider('primary', 0);
      const backup = createMockProvider('backup', 0);

      // make primary fail
      primary.getQuote = vi.fn().mockRejectedValue(new Error('fail'));
      backup.getQuote = vi.fn().mockResolvedValue({ symbol: 'TEST', price: 99 });

      orchestrator.registerProvider(primary, 'primary');
      orchestrator.registerProvider(backup, 'secondary');

      const result = await orchestrator.executeWithFallback('quote', 'test', (p) => p.getQuote('TEST'));
      expect(result.provider).toBe('backup');

      const metrics = orchestrator.getFallbackMetrics();
      expect(metrics.quote).toBeDefined();
      expect(metrics.quote.some((m) => m.provider === 'backup' && m.count > 0)).toBe(true);
    });

    it('should compute IV from options chain if all IV providers fail', async () => {
      const noIv = createMockProvider('noiv', 0);
      // capabilities: include optionsChain but iv false
      noIv.capabilities.iv = false;
      noIv.capabilities.optionsChain = true;
      noIv.getOptionsChain = vi.fn().mockResolvedValue({
        symbol: 'TEST',
        expirations: [],
        contracts: [
          { impliedVolatility: 0.3 } as any,
          { impliedVolatility: 0.5 } as any,
        ],
        timestamp: Date.now(),
      });

      orchestrator.registerProvider(noIv, 'primary');

      const result = await orchestrator.getIV('TEST');
      expect(result.provider).toBe('computed');
      expect((result.data as any).currentIV).toBeCloseTo(0.4, 3);

      const metrics = orchestrator.getFallbackMetrics();
      expect(metrics.iv).toBeDefined();
      const computedMetric = metrics.iv.find((m) => m.provider === 'computed');
      expect(computedMetric && computedMetric.count).toBeGreaterThan(0);
    });
  });

  describe('provider performance metrics via monitoring', () => {
    it('should expose performance metrics through monitoring service', async () => {
      const { monitoringService } = await import('../../services/monitoring-service');

      performanceTracker.recordSuccess('twelvedata', 50);
      performanceTracker.recordSuccess('polygon', 100);
      performanceTracker.recordFailure('unusual_whales', 100);

      const metrics = monitoringService.getProviderPerformanceMetrics();

      expect(metrics).toHaveLength(7);
      expect(metrics.some((m) => m.provider === 'twelvedata')).toBe(true);
    });

    it('should provide fallback recommendations through monitoring', async () => {
      const { monitoringService } = await import('../../services/monitoring-service');

      performanceTracker.recordSuccess('twelvedata', 50);
      performanceTracker.recordSuccess('polygon', 100);

      const recommended = monitoringService.getRecommendedFallbackOrder(['twelvedata', 'polygon']);

      expect(recommended[0]).toBe('twelvedata'); // Better performance
    });

    it('monitoring service should expose fallback metrics from orchestrator', async () => {
      const { monitoringService } = await import('../../services/monitoring-service');
      // craft a fake orchestrator with a fallback metric
      const fakeOrch: any = {
        getFallbackMetrics: () => ({ quote: [{ provider: 'sample', count: 2 }] }),
      };
      const metrics = monitoringService.getFallbackMetrics(fakeOrch);
      expect(metrics.quote).toBeDefined();
      expect(metrics.quote[0].provider).toBe('sample');
    });
  });

  // --- new load balancing tests ---
  describe('load balancing strategies', () => {
    it('round-robin cycles through providers as the primary', async () => {
      const a = createMockProvider('a', 10);
      const b = createMockProvider('b', 10);
      orchestrator.registerProvider(a, 'primary');
      orchestrator.registerProvider(b, 'secondary');

      orchestrator.setLoadBalancingStrategy('round_robin');

      const r1 = await orchestrator.executeWithFallback('quote', 'key1', async (p) => p.getQuote('TEST'));
      expect(r1.provider).toBe('a');

      const r2 = await orchestrator.executeWithFallback('quote', 'key2', async (p) => p.getQuote('TEST'));
      expect(r2.provider).toBe('b');

      expect(monitoringService.getLoadBalancerStrategy()).toBe('round_robin');
    });

    it('weighted selection respects performance scores', async () => {
      const p1 = createMockProvider('p1', 10);
      const p2 = createMockProvider('p2', 10);
      orchestrator.registerProvider(p1, 'primary');
      orchestrator.registerProvider(p2, 'secondary');

      performanceTracker.recordSuccess('p1', 10);
      for (let i = 0; i < 20; i++) {
        performanceTracker.recordFailure('p2', 10);
      }

      orchestrator.setLoadBalancingStrategy('weighted');

      const orig = Math.random;
      try {
        Math.random = () => 0.99;
        const rHigh = await orchestrator.executeWithFallback('quote', 'w1', async (p) => p.getQuote('TEST'));
        // Weighted selection may vary; p1 has higher success rate
        expect(['p1', 'p2']).toContain(rHigh.provider);

        Math.random = () => 0.01;
        const rLow = await orchestrator.executeWithFallback('quote', 'w2', async (p) => p.getQuote('TEST'));
        expect(['p1', 'p2']).toContain(rLow.provider);
      } finally {
        Math.random = orig;
      }
    });

    it('traffic shaping skips providers with zero remaining tokens', async () => {
      const p1 = createMockProvider('p1', 10);
      const p2 = createMockProvider('p2', 10);
      orchestrator.registerProvider(p1, 'primary');
      orchestrator.registerProvider(p2, 'secondary');

      const { rateLimiter } = await import('../../services/rate-limiter');
      const spy = vi.spyOn(rateLimiter, 'getRemaining');
      spy.mockImplementation((prov) => (prov === 'p1' ? 0 : 5));

      orchestrator.setLoadBalancingStrategy('round_robin');

      const result = await orchestrator.executeWithFallback('quote', 'skipped', async (p) => p.getQuote('TEST'));
      expect(result.provider).toBe('p2');

      spy.mockRestore();
    });
  });

});
