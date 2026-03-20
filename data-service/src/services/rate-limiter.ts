import { createChildLogger } from '../utils/logger';
import { redisCache } from '../cache/redis-cache';
import type { ProviderName } from '../types';

const log = createChildLogger('rate-limiter');

interface TokenBucket {
  tokens: number;
  maxTokens: number;
  refillRate: number;
  lastRefill: number;
  lastAcquireTime?: number;
  acquireCount?: number;
}

interface RateLimitConfig {
  provider: ProviderName;
  maxPerMinute: number;
  description?: string;
}

interface RateLimiterStatus {
  provider: ProviderName;
  configured: boolean;
  maxTokens?: number;
  remaining?: number;
  refillRate?: number;
  healthy: boolean;
  errorMessage?: string;
}

export class RateLimiter {
  private buckets = new Map<ProviderName, TokenBucket>();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Load persisted rate limiter states for all known providers
      const providers: ProviderName[] = ['twelvedata', 'unusual_whales', 'polygon', 'cboe', 'fred', 'marketdata', 'computed'];

      for (const provider of providers) {
        await this.loadBucketState(provider);
      }

      log.info('Rate limiter initialized and persisted states loaded');
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : err }, 'Failed to load persisted rate limiter states');
    } finally {
      this.initialized = true;
    }
  }

  private async loadBucketState(provider: ProviderName): Promise<void> {
    try {
      const persisted = await redisCache.get<TokenBucket>('ratelimit', provider);
      if (persisted?.data) {
        // Only restore if the configuration still makes sense
        const bucket = persisted.data;
        if (bucket.maxTokens && bucket.maxTokens > 0) {
          this.buckets.set(provider, bucket);
          log.debug({ provider, maxTokens: bucket.maxTokens }, 'Loaded rate limiter state from persistence');
        }
      }
    } catch (err) {
      log.warn({ provider, error: err instanceof Error ? err.message : err }, 'Failed to load rate limiter state');
    }
  }

  private async saveBucketState(provider: ProviderName): Promise<void> {
    const bucket = this.buckets.get(provider);
    if (!bucket) return;

    try {
      await redisCache.set('ratelimit', provider, bucket);
      log.debug({ provider }, 'Saved rate limiter state to persistence');
    } catch (err) {
      log.warn({ provider, error: err instanceof Error ? err.message : err }, 'Failed to save rate limiter state');
    }
  }

  configure(provider: ProviderName, maxPerMinute: number, description?: string): void {
    // Validation
    if (!this.isValidRateLimit(maxPerMinute)) {
      throw new Error(
        `Invalid rate limit for ${provider}: ${maxPerMinute}. Must be a positive number greater than 0.`
      );
    }

    this.buckets.set(provider, {
      tokens: maxPerMinute,
      maxTokens: maxPerMinute,
      refillRate: maxPerMinute / 60,
      lastRefill: Date.now(),
      lastAcquireTime: undefined,
      acquireCount: 0,
    });

    log.info({ provider, maxPerMinute, description }, 'Rate limiter configured');
  }

  /**
   * Validate that all provided rate limit configurations are correct
   * @param configs Array of rate limit configurations to validate
   * @throws Error if any configuration is invalid
   */
  validateConfiguration(configs: RateLimitConfig[]): void {
    const errors: string[] = [];

    for (const config of configs) {
      if (!config.provider) {
        errors.push('Missing provider name in configuration');
        continue;
      }

      if (!this.isValidRateLimit(config.maxPerMinute)) {
        errors.push(
          `Invalid rate limit for ${config.provider}: ${config.maxPerMinute}. Must be a positive number.`
        );
      }
    }

    if (errors.length > 0) {
      throw new Error(`Rate limit configuration validation failed:\n${errors.join('\n')}`);
    }

    log.info({ count: configs.length }, 'Rate limit configurations validated successfully');
  }

  /**
   * Check if all required providers have rate limit configurations
   * @param requiredProviders Array of providers that must be configured
   * @throws Error if any required provider is not configured
   */
  validateAllProvidersConfigured(requiredProviders: ProviderName[]): void {
    const missing = requiredProviders.filter((p) => !this.buckets.has(p));

    if (missing.length > 0) {
      throw new Error(
        `Rate limiter not configured for required providers: ${missing.join(', ')}`
      );
    }

    log.info({ providers: requiredProviders.length }, 'All required providers are rate-limited');
  }

  private isValidRateLimit(maxPerMinute: number | undefined): boolean {
    return typeof maxPerMinute === 'number' && maxPerMinute > 0 && isFinite(maxPerMinute);
  }

  async acquire(provider: ProviderName): Promise<void> {
    const bucket = this.buckets.get(provider);
    if (!bucket) {
      throw new Error(`Rate limiter not configured for provider: ${provider}`);
    }

    this.refill(bucket);

    if (bucket.tokens < 1) {
      const waitMs = ((1 - bucket.tokens) / bucket.refillRate) * 1000;
      log.warn({ provider, waitMs: Math.ceil(waitMs) }, 'Rate limit reached, waiting');
      await this.sleep(waitMs);
      this.refill(bucket);
    }

    bucket.tokens -= 1;
    bucket.lastAcquireTime = Date.now();
    bucket.acquireCount = (bucket.acquireCount ?? 0) + 1;

    // Periodically persist state
    if ((bucket.acquireCount % 10) === 0) {
      this.saveBucketState(provider);
    }
  }

  getRemaining(provider: ProviderName): number {
    const bucket = this.buckets.get(provider);
    if (!bucket) return 0;
    this.refill(bucket);
    return Math.floor(bucket.tokens);
  }

  getMax(provider: ProviderName): number {
    return this.buckets.get(provider)?.maxTokens ?? 0;
  }

  /**
   * Get detailed status for a specific provider
   */
  getStatus(provider: ProviderName): RateLimiterStatus {
    const bucket = this.buckets.get(provider);

    if (!bucket) {
      return {
        provider,
        configured: false,
        healthy: false,
        errorMessage: `Rate limiter not configured for provider: ${provider}`,
      };
    }

    this.refill(bucket);

    return {
      provider,
      configured: true,
      maxTokens: bucket.maxTokens,
      remaining: Math.floor(bucket.tokens),
      refillRate: bucket.refillRate,
      healthy: true,
    };
  }

  /**
   * Get status for all configured providers
   */
  getAllStatus(): RateLimiterStatus[] {
    return Array.from(this.buckets.keys()).map((provider) => this.getStatus(provider));
  }

  /**
   * Reset rate limiter for a specific provider back to max capacity
   */
  reset(provider: ProviderName): void {
    const bucket = this.buckets.get(provider);
    if (!bucket) {
      log.warn({ provider }, 'Attempted to reset unconfigured rate limiter');
      return;
    }

    const oldTokens = Math.floor(bucket.tokens);
    bucket.tokens = bucket.maxTokens;
    bucket.lastRefill = Date.now();
    bucket.acquireCount = 0;
    bucket.lastAcquireTime = undefined;

    log.info({ provider, oldTokens, maxTokens: bucket.maxTokens }, 'Rate limiter reset');
    this.saveBucketState(provider);
  }

  /**
   * Reset all rate limiters back to max capacity
   */
  resetAll(): void {
    for (const provider of this.buckets.keys()) {
      this.reset(provider);
    }
    log.info('All rate limiters reset');
  }

  /**
   * Check if a provider's rate limit is healthy
   */
  isHealthy(provider: ProviderName): boolean {
    const status = this.getStatus(provider);
    return status.healthy && status.configured;
  }

  private refill(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate);
    bucket.lastRefill = now;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const rateLimiter = new RateLimiter();
