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

  async get<T>(dataType: DataType, key: string): Promise<{ data: T; source: 'redis' | 'memory' } | null> {
    if (this.redis.isConnected()) {
      const val = await this.redis.get<T>(dataType, key);
      if (val !== undefined) {
        return { data: val, source: 'redis' };
      }
    }

    const memVal = this.memory.get<T>(dataType, key);
    if (memVal !== undefined) {
      return { data: memVal, source: 'memory' };
    }

    return null;
  }

  async set<T>(dataType: DataType, key: string, value: T): Promise<void> {
    this.memory.set(dataType, key, value);

    if (this.redis.isConnected()) {
      await this.redis.set(dataType, key, value);
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
