import Redis from 'ioredis';
import { createChildLogger } from '../utils/logger';
import { config } from '../config';
import type { DataType } from '../types';

const log = createChildLogger('redis-cache');

// default TTLs (seconds) used when no override is configured
const DEFAULT_TTL_MAP: Record<DataType, number> = {
  // reduced TTLs for high‑velocity data
  quote: 10,
  candles: 20,
  options_chain: 180,
  gex: 270,
  flow: 270,
  iv: 540,
  vix: 300,
  macro: 3600,
  underlying: 2,
  expirations: 86400,
  chain: 270,
  quotes: 30,
  greeks: 270,
  hist_candles: 86400,
  hist_metrics: 21600,
  hist_regime: 900,
  circuit: 86400, // Circuit breaker states persist for 24 hours
  ratelimit: 3600, // Rate limiter states persist for 1 hour
};

function resolveTtl(dataType: DataType): number {
  const override = config.cache?.ttl?.[dataType];
  if (override && override > 0) {
    return override;
  }
  return DEFAULT_TTL_MAP[dataType] ?? 30;
}

export class RedisCache {
  private client: Redis | null = null;
  private connected = false;
  private errorLogged = false;

  async connect(): Promise<boolean> {
    try {
      this.client = new Redis(config.redis.url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 3) return null;
          return Math.min(times * 500, 5000);
        },
        lazyConnect: true,
      });

      this.client.on('error', () => {
        if (!this.errorLogged) {
          log.warn('Redis unavailable — falling back to memory cache');
          this.errorLogged = true;
        }
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

  async get<T>(dataType: DataType, key: string): Promise<{ data: T; provider?: string } | undefined> {
    if (!this.isConnected()) return undefined;
    try {
      const fullKey = `ds:${dataType}:${key}`;
      const raw = await this.client!.get(fullKey);
      if (!raw) return undefined;
      return JSON.parse(raw) as { data: T; provider?: string };
    } catch (err) {
      log.warn({ key, error: err instanceof Error ? err.message : err }, 'Redis get failed');
      return undefined;
    }
  }

  async set<T>(dataType: DataType, key: string, value: { data: T; provider?: string } | T): Promise<void> {
    if (!this.isConnected()) return;
    try {
      const fullKey = `ds:${dataType}:${key}`;
      const ttl = resolveTtl(dataType);
      // if caller passed raw value, wrap it
      const payload = (value && (value as any).data !== undefined)
        ? value
        : { data: value as T };
      await this.client!.set(fullKey, JSON.stringify(payload), 'EX', ttl);
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
