import { createChildLogger, logger } from '../utils/logger';
import { rateLimiter } from './rate-limiter';
import { performanceTracker } from './provider-performance-tracker';
import { loadBalancer, LoadBalancingStrategy } from './load-balancer';
import { ProviderError, ServiceUnavailableError } from '../providers/base-provider';
import { cacheManager } from '../cache';
import { snapshotStore } from '../persistence';
import type { MacroRegimeService, MacroData } from './macro-regime';
import type {
  MarketDataProvider,
  ProviderName,
  ProviderCapabilities,
  ProviderPriority,
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
  Cached,
  OptionsContract,
} from '../types';

const log = createChildLogger('orchestrator');

/**
 * Priority order for provider selection (lower index = higher priority)
 */
const PRIORITY_ORDER: Record<ProviderPriority, number> = {
  primary: 0,
  secondary: 1,
  tertiary: 2,
};

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
  private providerRegistrationInfo = new Map<ProviderName, { registered: boolean; reason?: string; apiKeyConfigured: boolean }>();
  private lastErrors = new Map<ProviderName, string>();

  // Tracks fallback counts: how many times a given provider was used as a
  // non-primary (index > 0) for a capability. Useful for failover metrics.
  private fallbackStats = new Map<CapabilityKey, Map<ProviderName, number>>();

  /**
   * Allows callers to specify how the first provider is chosen when multiple
   * candidates are healthy.  Defaults to `none` (always use the highest-priority
   * provider).  See `LoadBalancer` for supported strategies.
   */
  setLoadBalancingStrategy(strategy: LoadBalancingStrategy): void {
    loadBalancer.setStrategy(strategy);
    log.info({ strategy }, 'Load balancing strategy set');
  }

  getLoadBalancingStrategy(): LoadBalancingStrategy {
    return loadBalancer.getStrategy();
  }


  registerProvider(provider: MarketDataProvider): void {
    this.providers.push(provider);
    this.requestMetrics.set(provider.name, { successes: 0, failures: 0, totalLatencyMs: 0 });
    this.providerRegistrationInfo.set(provider.name, { registered: true, apiKeyConfigured: true });
    // Sort providers by priority after registration
    this.providers.sort((a, b) => {
      const aPriority = PRIORITY_ORDER[a.priority || 'tertiary'];
      const bPriority = PRIORITY_ORDER[b.priority || 'tertiary'];
      return aPriority - bPriority;
    });
    log.info({ provider: provider.name, priority: provider.priority }, 'Provider registered');
  }

  trackProviderRegistrationFailure(providerName: ProviderName, reason: string, apiKeyConfigured: boolean): void {
    this.providerRegistrationInfo.set(providerName, { registered: false, reason, apiKeyConfigured });
  }

  getAllProviderNames(): ProviderName[] {
    const names = new Set<ProviderName>(this.providers.map(p => p.name));
    for (const name of this.providerRegistrationInfo.keys()) {
      names.add(name);
    }
    return Array.from(names);
  }

  setMacroRegimeService(service: MacroRegimeService): void {
    this.macroRegime = service;
    log.info('Macro regime service registered');
  }

  /**
   * Increment fallback counter when a provider other than the first choice
   * successfully handles a request for the given capability.
   */
  private recordFallback(capability: CapabilityKey, provider: ProviderName): void {
    const capMap = this.fallbackStats.get(capability) ?? new Map<ProviderName, number>();
    capMap.set(provider, (capMap.get(provider) ?? 0) + 1);
    this.fallbackStats.set(capability, capMap);
  }

  /**
   * Retrieve fallback statistics in consumable format.
   */
  getFallbackMetrics(): Record<CapabilityKey, { provider: ProviderName; count: number }[]> {
    const result: Record<CapabilityKey, { provider: ProviderName; count: number }[]> = {} as any;
    for (const [cap, map] of this.fallbackStats.entries()) {
      result[cap] = [];
      for (const [prov, cnt] of map.entries()) {
        result[cap].push({ provider: prov, count: cnt });
      }
    }
    return result;
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
    try {
      return await this.cachedExecute('iv', symbol, 'iv', `iv:${symbol}`, (p) => {
        if (!p.getIV) throw new ProviderError(p.name, 'NOT_SUPPORTED', 'No IV');
        return p.getIV(symbol);
      });
    } catch (firstErr) {
      // if there was an error (no provider usable or all failed), attempt to
      // compute implied vol from the options chain as a last-resort fallback.
      try {
        const chainResp = await this.cachedExecute(
          'options_chain',
          symbol,
          'optionsChain',
          `${symbol}`,
          (p) => {
            if (!p.getOptionsChain) throw new ProviderError(p.name, 'NOT_SUPPORTED', 'No options chain');
            return p.getOptionsChain(symbol);
          },
        );

        const ivValue = DataOrchestrator.computeIvFromChain(chainResp.data.contracts);
        log.warn({ symbol, ivValue }, 'Computed IV fallback used');
        // record fallback for computed provider
        this.recordFallback('iv', 'computed');
        // mark as computed provider
        const ivData: IVData = {
          symbol,
          currentIV: ivValue,
          ivRank: 0,
          ivPercentile: 0,
          historicalIV30: 0,
          historicalIV60: 0,
          historicalIV90: 0,
          timestamp: Date.now(),
        };
        return {
          data: ivData,
          provider: 'computed',
          cached: false,
          latencyMs: 0,
          timestamp: Date.now(),
        };
      } catch (secondErr) {
        log.warn({ symbol, error: secondErr instanceof Error ? secondErr.message : secondErr }, 'IV compute fallback failed');
        // rethrow original so caller sees the original failure
        throw firstErr;
      }
    }
  }


  /**
   * Calculate an approximate implied volatility from an options chain.
   * This is a naive implementation that averages the `impliedVolatility` field
   * across all contracts. Used only as a last‑resort fallback when no real API
   * providers are available.
   */
  private static computeIvFromChain(chain: OptionsContract[]): number {
    const ivs = chain
      .map((c) => c.impliedVolatility)
      .filter((v): v is number => typeof v === 'number' && !isNaN(v));
    if (ivs.length === 0) {
      throw new Error('Cannot compute IV from empty chain');
    }
    const sum = ivs.reduce((a, b) => a + b, 0);
    return sum / ivs.length;
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
    // Get all possible provider names (registered and unregistered)
    const allProviderNames = this.getAllProviderNames();
    
    // Log diagnostic warnings if no providers are registered
    if (this.providers.length === 0) {
      // Check if any providers failed to register
      const failedProviders = Array.from(this.providerRegistrationInfo.entries())
        .filter(([_, info]) => !info.registered);
      
      if (failedProviders.length > 0) {
        failedProviders.forEach(([providerName, info]) => {
          logger.warn(
            { provider: providerName, reason: info.reason, apiKeyConfigured: info.apiKeyConfigured },
            `Provider ${providerName} failed to register - ${info.reason}`,
          );
        });
        
        logger.warn('Zero data providers registered - service will not be able to fetch real market data');
      }
    }
    
    return allProviderNames.map((providerName) => {
      const provider = this.providers.find(p => p.name === providerName);
      const registrationInfo = this.providerRegistrationInfo.get(providerName);
      const metrics = this.requestMetrics.get(providerName);
      const total = (metrics?.successes ?? 0) + (metrics?.failures ?? 0);
      const lastError = this.lastErrors.get(providerName);

      return {
        name: providerName,
        healthy: !!provider,
        circuitState: 'closed' as const,
        successRate: total > 0 && metrics ? (metrics.successes / total) * 100 : 100,
        avgLatencyMs: total > 0 && metrics ? Math.round(metrics.totalLatencyMs / total) : 0,
        rateLimitRemaining: rateLimiter.getRemaining(providerName),
        rateLimitMax: rateLimiter.getMax(providerName),
        lastSuccess: null,
        lastFailure: null,
        consecutiveFailures: 0,
        registered: registrationInfo?.registered ?? false,
        registrationReason: registrationInfo?.reason,
        apiKeyConfigured: registrationInfo?.apiKeyConfigured ?? false,
        lastErrorMessage: lastError,
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
      log.debug({ dataType, key: cacheKey, source: cached.source, provider: cached.provider }, 'Cache hit');
      return {
        data: cached.data,
        provider: (cached.provider as ProviderName) || 'twelvedata',
        cached: true,
        latencyMs: 0,
        timestamp: Date.now(),
      };
    }

    const result = await this.executeWithFallback<T>(capability, coalescingKey, fn);

    // persist with provider info so future hits know origin
    await cacheManager.set(dataType, cacheKey, { data: result.data, provider: result.provider });

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
    }).catch(() => {});

    return promise;
  }

  private async doExecuteWithFallback<T>(
    capability: CapabilityKey,
    fn: (provider: MarketDataProvider) => Promise<T>,
  ): Promise<ProviderResponse<T>> {
    let eligible = this.providers.filter((p) => p.capabilities[capability]);

    // traffic shaping: proactively skip any provider that is completely out of
    // rate-limit tokens.  We'll only apply this filter if at least one
    // provider still has tokens, otherwise we'll let the normal logic proceed
    // and let the rate limiter handle waiting.
    const withTokens = eligible.filter((p) => rateLimiter.getRemaining(p.name) > 0);
    if (withTokens.length > 0) {
      eligible = withTokens;
    }

    // For GEX, skip computed provider if any real-API providers are available
    if (capability === 'gex' && eligible.some(p => p.name !== 'computed')) {
      eligible = eligible.filter(p => p.name !== 'computed');
      log.debug('Skipping computed GEX provider — real-API providers available');
    }

    if (eligible.length === 0) {
      // Check if no providers are registered at all
      const totalProviders = this.providers.length;
      if (totalProviders === 0) {
        throw new ServiceUnavailableError(
          'Market data service unavailable - no data providers configured',
        );
      }
      
      throw new ServiceUnavailableError(
        `No available providers for capability: ${capability}`,
      );
    }

    // Sort providers by performance (intelligent fallback ordering)
    const providerNames = eligible.map((p) => p.name);
    let sortedProviderNames = performanceTracker.getRecommendedFallbackOrder(providerNames);

    // Apply load balancing strategy to choose which provider should be tried
    // first.  This may rotate the sorted list depending on the chosen strategy.
    if (loadBalancer.getStrategy() !== 'none') {
      const primary = loadBalancer.choose(sortedProviderNames, capability);
      const idx = sortedProviderNames.indexOf(primary);
      if (idx > 0) {
        // move primary to front while preserving relative order of the others
        sortedProviderNames.splice(idx, 1);
        sortedProviderNames.unshift(primary);
      }
    }

    // Reorder eligible providers by the possibly-rotated list
    eligible = sortedProviderNames
      .map((name) => eligible.find((p) => p.name === name))
      .filter((p): p is MarketDataProvider => p !== undefined);

    const errors: Error[] = [];

    for (let idx = 0; idx < eligible.length; idx++) {
      const provider = eligible[idx];
      const start = Date.now();
      try {
        const data = await fn(provider);
        const latencyMs = Date.now() - start;

        this.recordSuccess(provider.name, latencyMs);

        // record fallback if we didn't use the first provider in the list
        if (idx > 0) {
          this.recordFallback(capability, provider.name);
        }

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
        
        // Store last error message for diagnostics (sanitize sensitive data)
        const errorMessage = this.sanitizeErrorMessage(error.message);
        this.lastErrors.set(provider.name, errorMessage);

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
    // Also record in performance tracker for intelligent fallback
    performanceTracker.recordSuccess(provider, latencyMs);
  }

  private recordFailure(provider: ProviderName, latencyMs: number): void {
    const metrics = this.requestMetrics.get(provider);
    if (metrics) {
      metrics.failures++;
      metrics.totalLatencyMs += latencyMs;
    }
    // Also record in performance tracker for intelligent fallback
    performanceTracker.recordFailure(provider, latencyMs);
  }

  private sanitizeErrorMessage(message: string): string {
    // Remove potential API keys or tokens from error messages
    return message
      .replace(/apikey[=:]\s*[a-zA-Z0-9_-]+/gi, 'apikey=***')
      .replace(/token[=:]\s*[a-zA-Z0-9_-]+/gi, 'token=***')
      .replace(/authorization:\s*bearer\s+[a-zA-Z0-9_-]+/gi, 'authorization: bearer ***')
      .substring(0, 200); // Limit length to avoid huge error messages
  }
}
