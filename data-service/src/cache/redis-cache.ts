import Redis from 'ioredis';
import { createChildLogger } from '../utils/logger';
import { config } from '../config';
import type { DataType } from '../types';

const log = createChildLogger('redis-cache');

const TTL_MAP: Record<DataType, number> = {
  quote: 15,
  candles: 30,
  options_chain: 60,
  gex: 120,
  flow: 60,
  iv: 120,
  vix: 300,
  macro: 3600,
};

export class RedisCache {
  private client: Redis | null = null;
  private connected = false;

  async connect(): Promise<boolean> {
    try {
      this.client = new Redis(config.redis.url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 200, 5000),
        lazyConnect: true,
      });

      this.client.on('error', (err) => {
        log.warn({ error: err.message }, 'Redis connection error');
        this.connected = false;
      });

      this.client.on('connect', () => {
        log.info('Redis connected');
        this.connected = true;
      });

      await this.client.connect();
      this.connected = true;
      return true;
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : err }, 'Redis unavailable, using memory cache');
      this.connected = false;
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  async get<T>(dataType: DataType, key: string): Promise<T | undefined> {
    if (!this.isConnected()) return undefined;
    try {
      const fullKey = `ds:${dataType}:${key}`;
      const raw = await this.client!.get(fullKey);
      if (!raw) return undefined;
      return JSON.parse(raw) as T;
    } catch (err) {
      log.warn({ key, error: err instanceof Error ? err.message : err }, 'Redis get failed');
      return undefined;
    }
  }

  async set<T>(dataType: DataType, key: string, value: T): Promise<void> {
    if (!this.isConnected()) return;
    try {
      const fullKey = `ds:${dataType}:${key}`;
      const ttl = TTL_MAP[dataType] ?? 30;
      await this.client!.set(fullKey, JSON.stringify(value), 'EX', ttl);
    } catch (err) {
      log.warn({ key, error: err instanceof Error ? err.message : err }, 'Redis set failed');
    }
  }

  async invalidate(dataType: DataType, key: string): Promise<void> {
    if (!this.isConnected()) return;
    await this.client!.del(`ds:${dataType}:${key}`);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.connected = false;
    }
  }
}

export const redisCache = new RedisCache();
