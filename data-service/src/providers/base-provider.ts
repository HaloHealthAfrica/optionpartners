import axios, { AxiosInstance, AxiosError } from 'axios';
import { createChildLogger } from '../utils/logger';
import { rateLimiter } from '../services/rate-limiter';
import { circuitBreaker } from '../services/circuit-breaker';
import type { ProviderName, ProviderCapabilities, ProviderConfig } from '../types';

export abstract class BaseProvider {
  abstract readonly name: ProviderName;
  abstract readonly capabilities: ProviderCapabilities;

  protected http: AxiosInstance;
  protected log;
  private latencies: number[] = [];
  private maxLatencySamples = 100;

  constructor(protected providerConfig: ProviderConfig) {
    this.log = createChildLogger(providerConfig.name);

    this.http = axios.create({
      baseURL: providerConfig.baseUrl,
      timeout: 15_000,
      headers: { 'User-Agent': 'TradePartners-DataService/0.1' },
    });

    rateLimiter.configure(providerConfig.name, providerConfig.rateLimit);
    circuitBreaker.configure(providerConfig.name, providerConfig.circuitBreaker);
  }

  protected async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<T> {
    if (!circuitBreaker.canExecute(this.name)) {
      throw new ProviderError(this.name, 'CIRCUIT_OPEN', 'Circuit breaker is open');
    }

    await rateLimiter.acquire(this.name);

    const start = Date.now();
    try {
      const response = await this.http.request<T>({
        method,
        url: path,
        params: method === 'GET' ? params : undefined,
        data: method === 'POST' ? params : undefined,
        headers,
      });

      const latency = Date.now() - start;
      this.recordLatency(latency);
      circuitBreaker.recordSuccess(this.name);

      this.log.debug({ path, latencyMs: latency }, 'Request succeeded');
      return response.data;
    } catch (err) {
      const latency = Date.now() - start;
      this.recordLatency(latency);
      circuitBreaker.recordFailure(this.name);

      if (err instanceof AxiosError) {
        const status = err.response?.status;
        const message = err.response?.data?.message || err.message;
        this.log.error({ path, status, latencyMs: latency, error: message }, 'Request failed');

        if (status === 429) {
          throw new ProviderError(this.name, 'RATE_LIMITED', `Rate limited by ${this.name}`);
        }
        if (status === 401 || status === 403) {
          throw new ProviderError(this.name, 'AUTH_ERROR', `Authentication failed for ${this.name}`);
        }
        throw new ProviderError(this.name, 'API_ERROR', message, status);
      }

      throw new ProviderError(this.name, 'UNKNOWN', String(err));
    }
  }

  getAverageLatency(): number {
    if (this.latencies.length === 0) return 0;
    return this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > this.maxLatencySamples) {
      this.latencies.shift();
    }
  }
}

export type ProviderErrorCode =
  | 'CIRCUIT_OPEN'
  | 'RATE_LIMITED'
  | 'AUTH_ERROR'
  | 'API_ERROR'
  | 'PARSE_ERROR'
  | 'NOT_SUPPORTED'
  | 'UNKNOWN';

export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderName,
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}

export class ServiceUnavailableError extends Error {
  public readonly statusCode = 503;
  
  constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

