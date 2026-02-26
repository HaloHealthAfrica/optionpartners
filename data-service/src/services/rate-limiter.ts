import { createChildLogger } from '../utils/logger';
import type { ProviderName } from '../types';

const log = createChildLogger('rate-limiter');

interface TokenBucket {
  tokens: number;
  maxTokens: number;
  refillRate: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<ProviderName, TokenBucket>();

  configure(provider: ProviderName, maxPerMinute: number): void {
    this.buckets.set(provider, {
      tokens: maxPerMinute,
      maxTokens: maxPerMinute,
      refillRate: maxPerMinute / 60,
      lastRefill: Date.now(),
    });
    log.info({ provider, maxPerMinute }, 'Rate limiter configured');
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
