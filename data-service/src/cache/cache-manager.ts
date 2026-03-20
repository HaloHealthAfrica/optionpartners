import { createChildLogger } from '../utils/logger';
import { redisCache, RedisCache } from './redis-cache';
import { memoryCache, MemoryCache } from './memory-cache';
import type { DataType } from '../types';

const log = createChildLogger('cache-manager');

/**
 * Unified cache that tries Redis first, falls back to in-memory.
 * Both layers share the same TTL semantics defined per DataType.
 */
export class CacheManager {
  constructor(
    private redis: RedisCache = redisCache,
    private memory: MemoryCache = memoryCache,
  ) {}

  async initialize(): Promise<void> {
    const redisOk = await this.redis.connect();
    log.info({ redisAvailable: redisOk }, 'Cache manager initialized');
  }

  async get<T>(dataType: DataType, key: string): Promise<{
    data: T;
    provider?: string;
    source: 'redis' | 'memory';
  } | null> {
    if (this.redis.isConnected()) {
      const val = await this.redis.get<T>(dataType, key);
      if (val !== undefined) {
        return { data: val.data, provider: val.provider, source: 'redis' };
      }
    }

    const memVal = this.memory.get<T>(dataType, key);
    if (memVal !== undefined) {
      return { data: memVal.data, provider: memVal.provider, source: 'memory' };
    }

    return null;
  }

  async set<T>(dataType: DataType, key: string, value: { data: T; provider?: string } | T): Promise<void> {
    // store wrapper so origin provider can be tracked
    const payload = (value && (value as any).data !== undefined)
      ? value as { data: T; provider?: string }
      : { data: value as T };

    this.memory.set(dataType, key, payload);

    if (this.redis.isConnected()) {
      await this.redis.set(dataType, key, payload);
    }
  }

  async invalidate(dataType: DataType, key: string): Promise<void> {
    this.memory.invalidate(dataType, key);
    await this.redis.invalidate(dataType, key);
  }

  async shutdown(): Promise<void> {
    await this.redis.disconnect();
    this.memory.flush();
  }
}

export const cacheManager = new CacheManager();
