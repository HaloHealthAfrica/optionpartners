import { createChildLogger } from '../utils/logger';
import { circuitBreaker } from './circuit-breaker';
import { rateLimiter } from './rate-limiter';
import { ProviderError } from '../providers/base-provider';
import { cacheManager } from '../cache';
import { snapshotStore } from '../persistence';
import type { MacroRegimeService, MacroData } from './macro-regime';
import type {
  MarketDataProvider,
  ProviderName,
  ProviderCapabilities,
  ProviderHealth,
  ProviderResponse,
  Candle,
  Quote,
  OptionsChain,
  GexData,
  OptionsFlowSummary,
  IVData,
  VixData,
  MarketRegime,
  MarketHours,
  Timeframe,
  DataType,
} from '../types';

const log = createChildLogger('orchestrator');

type CapabilityKey = keyof ProviderCapabilities;

/**
 * Routes data requests to providers in priority order with automatic
 * fallback, promise coalescing, and observability.
 */
export class DataOrchestrator {
  private providers: MarketDataProvider[] = [];
  private inflightRequests = new Map<string, Promise<unknown>>();
  private requestMetrics = new Map<ProviderName, { successes: number; failures: number; totalLatencyMs: number }>();
  private macroRegime: MacroRegimeService | null = null;

  registerProvider(provider: MarketDataProvider): void {
    this.providers.push(provider);
    this.requestMetrics.set(provider.name, { successes: 0, failures: 0, totalLatencyMs: 0 });
    log.info({ provider: provider.name }, 'Provider registered');
  }

  setMacroRegimeService(service: MacroRegimeService): void {
    this.macroRegime = service;
    log.info('Macro regime service registered');
  }

  // --- Public data methods (cache-aware) ---

  async getQuote(symbol: string): Promise<ProviderResponse<Quote>> {
    return this.cachedExecute('quote', symbol, 'quotes', symbol, (p) => p.getQuote(symbol));
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit?: number): Promise<ProviderResponse<Candle[]>> {
    const cacheKey = `${symbol}:${timeframe}:${limit ?? 100}`;
    return this.cachedExecute('candles', cacheKey, 'candles', cacheKey, (p) =>
      p.getCandles(symbol, timeframe, limit),
    );
  }

  async getMarketHours(): Promise<ProviderResponse<MarketHours>> {
    return this.executeWithFallback('marketHours', 'market_hours', (p) => {
      if (!p.getMarketHours) throw new ProviderError(p.name, 'NOT_SUPPORTED', 'No market hours');
      return p.getMarketHours();
    });
  }

  async getOptionsChain(symbol: string, expiration?: string): Promise<ProviderResponse<OptionsChain>> {
    const cacheKey = `${symbol}:${expiration ?? 'all'}`;
    return this.cachedExecute('options_chain', cacheKey, 'optionsChain', cacheKey, (p) => {
      if (!p.getOptionsChain) throw new ProviderError(p.name, 'NOT_SUPPORTED', 'No options chain');
      return p.getOptionsChain(symbol, expiration);
    });
  }

  async getGEX(symbol: string): Promise<ProviderResponse<GexData>> {
    return this.cachedExecute('gex', symbol, 'gex', `gex:${symbol}`, (p) => {
      if (!p.getGEX) throw new ProviderError(p.name, 'NOT_SUPPORTED', 'No GEX');
      return p.getGEX(symbol);
    });
  }

  async getFlow(symbol: string): Promise<ProviderResponse<OptionsFlowSummary>> {
    return this.cachedExecute('flow', symbol, 'flow', `flow:${symbol}`, (p) => {
      if (!p.getFlow) throw new ProviderError(p.name, 'NOT_SUPPORTED', 'No flow');
      return p.getFlow(symbol);
    });
  }

  async getIV(symbol: string): Promise<ProviderResponse<IVData>> {
    return this.cachedExecute('iv', symbol, 'iv', `iv:${symbol}`, (p) => {
      if (!p.getIV) throw new ProviderError(p.name, 'NOT_SUPPORTED', 'No IV');
      return p.getIV(symbol);
    });
  }

  // --- VIX / Macro / Regime ---

  async getVIX(): Promise<ProviderResponse<VixData>> {
    if (!this.macroRegime) {
      throw new Error('Macro regime service not registered');
    }
    const start = Date.now();
    const data = await this.macroRegime.getVixData();
    return { data, provider: 'cboe', cached: false, latencyMs: Date.now() - start, timestamp: Date.now() };
  }

  async getMarketRegime(): Promise<ProviderResponse<MarketRegime>> {
    if (!this.macroRegime) {
      throw new Error('Macro regime service not registered');
    }
    const start = Date.now();
    const data = await this.macroRegime.getMarketRegime();
    return { data, provider: 'cboe', cached: false, latencyMs: Date.now() - start, timestamp: Date.now() };
  }

  async getMacroData(): Promise<ProviderResponse<MacroData>> {
    if (!this.macroRegime) {
      throw new Error('Macro regime service not registered');
    }
    const start = Date.now();
    const data = await this.macroRegime.getMacroData();
    return { data, provider: 'fred', cached: false, latencyMs: Date.now() - start, timestamp: Date.now() };
  }

  // --- Snapshot persistence hooks ---

  async getGEXWithSnapshot(symbol: string): Promise<ProviderResponse<GexData>> {
    const result = await this.getGEX(symbol);
    if (!result.cached) {
      await snapshotStore.saveGexSnapshot(result.data, result.provider);
    }
    return result;
  }

  async getFlowWithSnapshot(symbol: string): Promise<ProviderResponse<OptionsFlowSummary>> {
    const result = await this.getFlow(symbol);
    if (!result.cached) {
      await snapshotStore.saveFlowSnapshot(result.data, result.provider);
    }
    return result;
  }

  async getCandlesWithSnapshot(
    symbol: string, timeframe: Timeframe, limit?: number,
  ): Promise<ProviderResponse<Candle[]>> {
    const result = await this.getCandles(symbol, timeframe, limit);
    if (!result.cached) {
      await snapshotStore.saveCandles(symbol, timeframe, result.data, result.provider);
    }
    return result;
  }

  // --- Health & metrics ---

  getProviderHealths(): ProviderHealth[] {
    return this.providers.map((p) => {
      const metrics = this.requestMetrics.get(p.name);
      const total = (metrics?.successes ?? 0) + (metrics?.failures ?? 0);
      const cbStats = circuitBreaker.getStats(p.name);

      return {
        name: p.name,
        healthy: circuitBreaker.canExecute(p.name),
        circuitState: circuitBreaker.getState(p.name),
        successRate: total > 0 ? (metrics!.successes / total) * 100 : 100,
        avgLatencyMs: total > 0 ? Math.round(metrics!.totalLatencyMs / total) : 0,
        rateLimitRemaining: rateLimiter.getRemaining(p.name),
        rateLimitMax: rateLimiter.getMax(p.name),
        lastSuccess: cbStats?.lastSuccessTime ?? null,
        lastFailure: cbStats?.lastFailureTime ?? null,
        consecutiveFailures: circuitBreaker.getConsecutiveFailures(p.name),
      };
    });
  }

  async runHealthChecks(): Promise<Record<ProviderName, boolean>> {
    const results: Record<string, boolean> = {};
    await Promise.all(
      this.providers.map(async (p) => {
        results[p.name] = await p.healthCheck();
      }),
    );
    return results as Record<ProviderName, boolean>;
  }

  // --- Cache-aware execution ---

  private async cachedExecute<T>(
    dataType: DataType,
    cacheKey: string,
    capability: CapabilityKey,
    coalescingKey: string,
    fn: (provider: MarketDataProvider) => Promise<T>,
  ): Promise<ProviderResponse<T>> {
    const cached = await cacheManager.get<T>(dataType, cacheKey);
    if (cached) {
      log.debug({ dataType, key: cacheKey, source: cached.source }, 'Cache hit');
      return {
        data: cached.data,
        provider: 'twelvedata', // cache doesn't track origin provider
        cached: true,
        latencyMs: 0,
        timestamp: Date.now(),
      };
    }

    const result = await this.executeWithFallback<T>(capability, coalescingKey, fn);

    await cacheManager.set(dataType, cacheKey, result.data);

    return result;
  }

  // --- Core fallback + coalescing logic ---

  private async executeWithFallback<T>(
    capability: CapabilityKey,
    coalescingKey: string,
    fn: (provider: MarketDataProvider) => Promise<T>,
  ): Promise<ProviderResponse<T>> {
    // Promise coalescing: if an identical request is in-flight, piggyback on it
    const existing = this.inflightRequests.get(coalescingKey);
    if (existing) {
      log.debug({ key: coalescingKey }, 'Coalescing duplicate request');
      return existing as Promise<ProviderResponse<T>>;
    }

    const promise = this.doExecuteWithFallback<T>(capability, fn);

    this.inflightRequests.set(coalescingKey, promise);
    promise.finally(() => {
      this.inflightRequests.delete(coalescingKey);
    });

    return promise;
  }

  private async doExecuteWithFallback<T>(
    capability: CapabilityKey,
    fn: (provider: MarketDataProvider) => Promise<T>,
  ): Promise<ProviderResponse<T>> {
    const eligible = this.providers.filter(
      (p) => p.capabilities[capability] && circuitBreaker.canExecute(p.name),
    );

    if (eligible.length === 0) {
      throw new ProviderError(
        'twelvedata',
        'CIRCUIT_OPEN',
        `No available providers for capability: ${capability}`,
      );
    }

    const errors: Error[] = [];

    for (const provider of eligible) {
      const start = Date.now();
      try {
        const data = await fn(provider);
        const latencyMs = Date.now() - start;

        this.recordSuccess(provider.name, latencyMs);

        return {
          data,
          provider: provider.name,
          cached: false,
          latencyMs,
          timestamp: Date.now(),
        };
      } catch (err) {
        const latencyMs = Date.now() - start;
        this.recordFailure(provider.name, latencyMs);

        const error = err instanceof Error ? err : new Error(String(err));
        errors.push(error);

        log.warn(
          { provider: provider.name, capability, error: error.message, latencyMs },
          'Provider failed, trying next',
        );
      }
    }

    const combined = errors.map((e) => e.message).join('; ');
    throw new Error(`All providers failed for ${capability}: ${combined}`);
  }

  private recordSuccess(provider: ProviderName, latencyMs: number): void {
    const metrics = this.requestMetrics.get(provider);
    if (metrics) {
      metrics.successes++;
      metrics.totalLatencyMs += latencyMs;
    }
  }

  private recordFailure(provider: ProviderName, latencyMs: number): void {
    const metrics = this.requestMetrics.get(provider);
    if (metrics) {
      metrics.failures++;
      metrics.totalLatencyMs += latencyMs;
    }
  }
}
