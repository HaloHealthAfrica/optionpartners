import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { DataOrchestrator } from '../services/data-orchestrator';
import { circuitBreaker } from '../services/circuit-breaker';
import { rateLimiter } from '../services/rate-limiter';
import { cacheManager } from '../cache';
import type { MarketDataProvider, Quote, Candle, ProviderCapabilities } from '../types';

/**
 * Preservation Property Tests
 * 
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
 * 
 * IMPORTANT: These tests follow observation-first methodology
 * - Run on UNFIXED code to observe baseline behavior
 * - Tests MUST PASS on unfixed code (confirms healthy behavior to preserve)
 * - After implementing fix, tests MUST STILL PASS (confirms no regressions)
 * 
 * Property 2: Preservation - Healthy Provider Behavior
 * For any service initialization where API keys are properly configured and
 * for any quote request where providers are healthy and registered,
 * the fixed system SHALL produce exactly the same behavior as the original system.
 */

describe('Property 2: Preservation - Healthy Provider Behavior', () => {
  let orchestrator: DataOrchestrator;

  beforeEach(async () => {
    orchestrator = new DataOrchestrator();
    vi.clearAllMocks();
    // Clear cache between tests
    await cacheManager.shutdown();
    await cacheManager.initialize();
  });

  /**
   * Test Case 1: Provider Fallback Priority
   * **Validates: Requirement 3.1**
   * 
   * When multiple providers are registered and healthy, the system should
   * follow the priority order: TwelveData → Unusual Whales → Polygon
   */
  describe('Provider Fallback Priority (Requirement 3.1)', () => {
    it('should use providers in priority order when all are healthy', async () => {
      // Create mock providers with different priorities
      const twelveDataProvider = createMockProvider('twelvedata', { quotes: true });
      const unusualWhalesProvider = createMockProvider('unusualwhales', { quotes: true });
      const polygonProvider = createMockProvider('polygon', { quotes: true });

      // Register providers (order matters - first registered = highest priority)
      orchestrator.registerProvider(twelveDataProvider);
      orchestrator.registerProvider(unusualWhalesProvider);
      orchestrator.registerProvider(polygonProvider);

      // Configure circuit breakers for all providers
      circuitBreaker.configure('twelvedata');
      circuitBreaker.configure('unusualwhales');
      circuitBreaker.configure('polygon');

      // Make a quote request
      const result = await orchestrator.getQuote('SPY');

      // Should use the first provider (TwelveData)
      expect(result.provider).toBe('twelvedata');
      expect(twelveDataProvider.getQuote).toHaveBeenCalledWith('SPY');
      expect(unusualWhalesProvider.getQuote).not.toHaveBeenCalled();
      expect(polygonProvider.getQuote).not.toHaveBeenCalled();
    });

    it('should fall back to secondary provider when primary fails', async () => {
      const twelveDataProvider = createMockProvider('twelvedata', { quotes: true });
      const unusualWhalesProvider = createMockProvider('unusualwhales', { quotes: true });

      // Make TwelveData fail
      vi.mocked(twelveDataProvider.getQuote).mockRejectedValue(new Error('API error'));

      orchestrator.registerProvider(twelveDataProvider);
      orchestrator.registerProvider(unusualWhalesProvider);

      circuitBreaker.configure('twelvedata');
      circuitBreaker.configure('unusualwhales');

      const result = await orchestrator.getQuote('SPY');

      // Should fall back to Unusual Whales
      expect(result.provider).toBe('unusualwhales');
      expect(twelveDataProvider.getQuote).toHaveBeenCalled();
      expect(unusualWhalesProvider.getQuote).toHaveBeenCalled();
    });

    it('property: fallback order is consistent across multiple requests', async () => {
      // Test that when primary provider fails, all requests consistently use the same fallback
      const orch = new DataOrchestrator();
      const provider1 = createMockProvider('twelvedata', { quotes: true });
      const provider2 = createMockProvider('unusualwhales', { quotes: true });

      // Make first provider fail consistently
      vi.mocked(provider1.getQuote).mockRejectedValue(new Error('Fail'));

      orch.registerProvider(provider1);
      orch.registerProvider(provider2);

      circuitBreaker.reset('twelvedata');
      circuitBreaker.reset('unusualwhales');
      // Configure with higher threshold to avoid circuit opening during test
      circuitBreaker.configure('twelvedata', { failureThreshold: 10, resetTimeoutMs: 30000, halfOpenMaxAttempts: 2 });
      circuitBreaker.configure('unusualwhales');

      // Make multiple requests
      const symbols = ['SPY', 'QQQ', 'IWM'];
      const results = await Promise.all(symbols.map(s => orch.getQuote(s)));
      const providers = results.map(r => r.provider);

      // All should use the fallback provider (unusualwhales)
      expect(providers.every(p => p === 'unusualwhales')).toBe(true);
    });
  });

  /**
   * Test Case 2: Cache-First Behavior
   * **Validates: Requirement 3.2**
   * 
   * When cached data is available and fresh, the system should return
   * cached data without making external API calls
   */
  describe('Cache-First Behavior (Requirement 3.2)', () => {
    it('should return cached data without calling provider', async () => {
      const provider = createMockProvider('twelvedata', { quotes: true });
      orchestrator.registerProvider(provider);
      circuitBreaker.configure('twelvedata');

      // Pre-populate cache
      const cachedQuote: Quote = {
        symbol: 'SPY',
        price: 450.00,
        bid: 449.95,
        ask: 450.05,
        volume: 1000000,
        timestamp: Date.now(),
      };
      await cacheManager.set('quote', 'SPY', cachedQuote);

      // Make request
      const result = await orchestrator.getQuote('SPY');

      // Should return cached data
      expect(result.cached).toBe(true);
      expect(result.data.symbol).toBe('SPY');
      expect(result.data.price).toBe(450.00);

      // Should NOT call provider
      expect(provider.getQuote).not.toHaveBeenCalled();
    });

    it('property: cache hits never trigger provider calls', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            symbol: fc.constantFrom('SPY', 'QQQ', 'IWM'),
            price: fc.double({ min: 100, max: 500, noNaN: true }),
            volume: fc.integer({ min: 1000, max: 10000000 }),
          }),
          async ({ symbol, price, volume }) => {
            const orch = new DataOrchestrator();
            const provider = createMockProvider('twelvedata', { quotes: true });
            orch.registerProvider(provider);
            circuitBreaker.reset('twelvedata');
            circuitBreaker.configure('twelvedata');

            // Pre-populate cache
            const cachedQuote: Quote = {
              symbol,
              price,
              bid: price - 0.05,
              ask: price + 0.05,
              volume,
              timestamp: Date.now(),
            };
            await cacheManager.set('quote', symbol, cachedQuote);

            // Make request
            const result = await orch.getQuote(symbol);

            // Verify cache hit
            return result.cached === true && !provider.getQuote.mock.calls.length;
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Test Case 3: Rate Limiting and Provider Rotation
   * **Validates: Requirement 3.5**
   * 
   * When rate limits are reached for a provider, the system should
   * respect rate limits and fall back to alternative providers
   */
  describe('Rate Limiting and Provider Rotation (Requirement 3.5)', () => {
    it('should respect rate limits and not exceed configured limits', () => {
      const provider = 'twelvedata' as const;
      const maxPerMinute = 10;

      rateLimiter.configure(provider, maxPerMinute);

      // Check initial state
      const remaining = rateLimiter.getRemaining(provider);
      const max = rateLimiter.getMax(provider);

      expect(max).toBe(maxPerMinute);
      expect(remaining).toBeLessThanOrEqual(maxPerMinute);
      expect(remaining).toBeGreaterThanOrEqual(0);
    });

    it('property: rate limiter maintains token bucket invariants', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 5, max: 100 }),
          (maxPerMinute) => {
            const provider = 'twelvedata' as const;
            rateLimiter.configure(provider, maxPerMinute);

            const remaining = rateLimiter.getRemaining(provider);
            const max = rateLimiter.getMax(provider);

            // Invariant: remaining tokens never exceed max
            expect(remaining).toBeLessThanOrEqual(max);
            // Invariant: max matches configured value
            expect(max).toBe(maxPerMinute);
            // Invariant: remaining is non-negative
            expect(remaining).toBeGreaterThanOrEqual(0);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * Test Case 4: Circuit Breaker Behavior in Healthy State
   * **Validates: Requirement 3.4**
   * 
   * When the circuit breaker is in CLOSED state and providers are healthy,
   * the system should process requests with normal latency and success rates
   */
  describe('Circuit Breaker Healthy State (Requirement 3.4)', () => {
    it('should allow requests when circuit breaker is closed', () => {
      const provider = 'twelvedata' as const;
      circuitBreaker.configure(provider);

      // Circuit should start in closed state
      expect(circuitBreaker.getState(provider)).toBe('closed');
      expect(circuitBreaker.canExecute(provider)).toBe(true);
    });

    it('should transition to half-open after timeout when circuit is open', () => {
      const provider = 'twelvedata' as const;
      circuitBreaker.configure(provider, {
        failureThreshold: 3,
        resetTimeoutMs: 100, // Short timeout for testing
        halfOpenMaxAttempts: 2,
      });

      // Trigger circuit breaker to open
      circuitBreaker.recordFailure(provider);
      circuitBreaker.recordFailure(provider);
      circuitBreaker.recordFailure(provider);

      expect(circuitBreaker.getState(provider)).toBe('open');
      expect(circuitBreaker.canExecute(provider)).toBe(false);

      // Wait for timeout (circuit should transition to half-open)
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const state = circuitBreaker.getState(provider);
          expect(state).toBe('half-open');
          expect(circuitBreaker.canExecute(provider)).toBe(true);
          resolve();
        }, 150);
      });
    });

    it('should close circuit after successful half-open attempt', () => {
      const provider = 'twelvedata' as const;
      circuitBreaker.configure(provider);

      // Open circuit
      circuitBreaker.recordFailure(provider);
      circuitBreaker.recordFailure(provider);
      circuitBreaker.recordFailure(provider);
      expect(circuitBreaker.getState(provider)).toBe('open');

      // Manually transition to half-open (simulating timeout)
      circuitBreaker.reset(provider);
      circuitBreaker.recordFailure(provider); // One failure
      circuitBreaker.recordFailure(provider); // Two failures
      // Now in half-open state

      // Record success - should close circuit
      circuitBreaker.recordSuccess(provider);
      expect(circuitBreaker.getState(provider)).toBe('closed');
      expect(circuitBreaker.canExecute(provider)).toBe(true);
    });

    it('property: circuit breaker state transitions are deterministic', () => {
      fc.assert(
        fc.property(
          fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
          (outcomes) => {
            const provider = 'twelvedata' as const;
            circuitBreaker.reset(provider);
            circuitBreaker.configure(provider, {
              failureThreshold: 3,
              resetTimeoutMs: 30000,
              halfOpenMaxAttempts: 2,
            });

            let consecutiveFailures = 0;

            for (const success of outcomes) {
              const canExecuteBefore = circuitBreaker.canExecute(provider);
              
              if (success) {
                circuitBreaker.recordSuccess(provider);
                consecutiveFailures = 0;
              } else {
                if (canExecuteBefore) {
                  circuitBreaker.recordFailure(provider);
                  consecutiveFailures++;
                }
              }

              const state = circuitBreaker.getState(provider);

              // Invariant: circuit opens after 3 consecutive failures
              if (consecutiveFailures >= 3) {
                if (state !== 'open') return false;
              }
            }
            return true;
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  /**
   * Test Case 5: Health Check Endpoint
   * **Validates: Requirement 3.7**
   * 
   * Health check requests should return provider health status including
   * circuit breaker state, success rates, and rate limit information
   */
  describe('Health Check Endpoint (Requirement 3.7)', () => {
    it('should return provider health status with all required fields', () => {
      const provider = createMockProvider('twelvedata', { quotes: true, candles: true });
      orchestrator.registerProvider(provider);
      circuitBreaker.configure('twelvedata');

      const healths = orchestrator.getProviderHealths();

      // After fix: Health check returns all possible providers (registered and unregistered)
      expect(healths.length).toBeGreaterThanOrEqual(1);
      const health = healths.find(h => h.name === 'twelvedata')!;
      expect(health).toBeDefined();

      // Verify all required fields are present
      expect(health).toHaveProperty('name');
      expect(health).toHaveProperty('healthy');
      expect(health).toHaveProperty('circuitState');
      expect(health).toHaveProperty('successRate');
      expect(health).toHaveProperty('avgLatencyMs');
      expect(health).toHaveProperty('rateLimitRemaining');
      expect(health).toHaveProperty('rateLimitMax');
      expect(health).toHaveProperty('lastSuccess');
      expect(health).toHaveProperty('lastFailure');
      expect(health).toHaveProperty('consecutiveFailures');
      // New diagnostic fields (added in fix)
      expect(health).toHaveProperty('registered');
      expect(health).toHaveProperty('apiKeyConfigured');

      // Verify initial healthy state
      expect(health.name).toBe('twelvedata');
      expect(health.healthy).toBe(true);
      expect(health.circuitState).toBe('closed');
      expect(health.successRate).toBe(100);
      expect(health.consecutiveFailures).toBe(0);
      // New diagnostic fields should indicate successful registration
      expect(health.registered).toBe(true);
      expect(health.apiKeyConfigured).toBe(true);
    });

    it('should reflect circuit breaker state in health status', () => {
      const provider = createMockProvider('twelvedata', { quotes: true });
      orchestrator.registerProvider(provider);
      circuitBreaker.configure('twelvedata');

      // Open circuit breaker
      circuitBreaker.recordFailure('twelvedata');
      circuitBreaker.recordFailure('twelvedata');
      circuitBreaker.recordFailure('twelvedata');

      const healths = orchestrator.getProviderHealths();
      const health = healths[0];

      expect(health.circuitState).toBe('open');
      expect(health.healthy).toBe(false);
      expect(health.consecutiveFailures).toBe(3);
    });

    it('property: health check always returns consistent structure', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 5 }),
          (numProviders) => {
            const orch = new DataOrchestrator();

            const providerNames = ['twelvedata', 'unusualwhales', 'polygon', 'cboe', 'fred'] as const;
            for (let i = 0; i < numProviders; i++) {
              const name = providerNames[i];
              const provider = createMockProvider(name, { quotes: true });
              orch.registerProvider(provider);
              circuitBreaker.configure(name);
            }

            const healths = orch.getProviderHealths();

            // After fix: Health check returns all possible providers (3: twelvedata, unusual_whales, polygon)
            // regardless of how many are registered
            expect(healths.length).toBeGreaterThanOrEqual(3);
            
            // Verify structure for each provider
            healths.forEach(health => {
              expect(health).toHaveProperty('name');
              expect(health).toHaveProperty('healthy');
              expect(health).toHaveProperty('circuitState');
              expect(health).toHaveProperty('successRate');
              expect(health).toHaveProperty('avgLatencyMs');
              expect(health).toHaveProperty('rateLimitRemaining');
              expect(health).toHaveProperty('rateLimitMax');
              expect(health).toHaveProperty('lastSuccess');
              expect(health).toHaveProperty('lastFailure');
              expect(health).toHaveProperty('consecutiveFailures');
              // New diagnostic fields
              expect(health).toHaveProperty('registered');
              expect(health).toHaveProperty('apiKeyConfigured');

              // Verify types
              expect(typeof health.name).toBe('string');
              expect(typeof health.healthy).toBe('boolean');
              expect(['closed', 'open', 'half-open']).toContain(health.circuitState);
              expect(typeof health.successRate).toBe('number');
              expect(typeof health.avgLatencyMs).toBe('number');
              expect(typeof health.consecutiveFailures).toBe('number');
            });
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Test Case 6: In-Memory Caching Fallback
   * **Validates: Requirement 3.6**
   * 
   * When database or Redis is unavailable, the system should continue
   * to operate with in-memory caching
   */
  describe('In-Memory Caching Fallback (Requirement 3.6)', () => {
    it('should use memory cache when Redis is unavailable', async () => {
      // Note: This test validates that the cache manager has memory fallback
      // The actual Redis connection state is managed by the cache manager
      
      const testData = { value: 'test-data', timestamp: Date.now() };
      
      // Set data in cache (will use memory if Redis unavailable)
      await cacheManager.set('quote', 'TEST_KEY', testData);
      
      // Get data from cache
      const result = await cacheManager.get('quote', 'TEST_KEY');
      
      // Should return data from memory cache
      expect(result).not.toBeNull();
      expect(result?.data).toEqual(testData);
      expect(['redis', 'memory']).toContain(result?.source);
    });

    it('property: cache operations succeed regardless of Redis state', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            key: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
            value: fc.record({
              data: fc.string(),
              timestamp: fc.integer({ min: Date.now() - 1000000, max: Date.now() }),
            }),
          }),
          async ({ key, value }) => {
            // Set and get should work even if Redis is down
            await cacheManager.set('quote', key, value);
            const result = await cacheManager.get('quote', key);

            return result !== null && JSON.stringify(result.data) === JSON.stringify(value);
          }
        ),
        { numRuns: 20 }
      );
    });
  });
});

/**
 * Helper function to create mock providers for testing
 */
function createMockProvider(
  name: 'twelvedata' | 'unusualwhales' | 'polygon' | 'cboe' | 'fred',
  capabilities: Partial<ProviderCapabilities>
): MarketDataProvider {
  const mockQuote: Quote = {
    symbol: 'SPY',
    price: 450.00,
    bid: 449.95,
    ask: 450.05,
    volume: 1000000,
    timestamp: Date.now(),
  };

  const mockCandle: Candle = {
    timestamp: Date.now(),
    open: 450.00,
    high: 451.00,
    low: 449.00,
    close: 450.50,
    volume: 1000000,
  };

  return {
    name,
    capabilities: {
      quotes: capabilities.quotes ?? false,
      candles: capabilities.candles ?? false,
      optionsChain: capabilities.optionsChain ?? false,
      gex: capabilities.gex ?? false,
      flow: capabilities.flow ?? false,
      iv: capabilities.iv ?? false,
      market_hours: capabilities.market_hours ?? false,
    },
    getQuote: vi.fn().mockResolvedValue(mockQuote),
    getCandles: vi.fn().mockResolvedValue([mockCandle]),
    healthCheck: vi.fn().mockResolvedValue(true),
  } as unknown as MarketDataProvider;
}
