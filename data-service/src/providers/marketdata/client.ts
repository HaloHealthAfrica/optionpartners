import axios, { AxiosInstance, AxiosError } from 'axios';
import { createChildLogger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Raw API response types (MarketData.app returns columnar arrays)
// ---------------------------------------------------------------------------

interface RawExpirationsResponse {
  s: string;
  expirations: string[];
}

interface RawChainResponse {
  s: string;
  optionSymbol: string[];
  underlying: string[];
  expiration: number[];
  side: string[];
  strike: number[];
  bid: number[];
  ask: number[];
  mid: number[];
  last: number[];
  volume: number[];
  openInterest: number[];
  iv: number[];
  delta: number[];
  gamma: number[];
  theta: number[];
  vega: number[];
  updated: number[];
}

interface RawQuotesResponse {
  s: string;
  optionSymbol: string[];
  bid: number[];
  ask: number[];
  mid: number[];
  last: number[];
  volume: number[];
  openInterest: number[];
  iv: number[];
  delta: number[];
  gamma: number[];
  theta: number[];
  vega: number[];
  updated: number[];
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MarketDataOptionContract {
  optionSymbol: string;
  underlying: string;
  expiration: string;
  side: 'call' | 'put';
  strike: number;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume: number;
  openInterest: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  updated: number;
}

export interface MarketDataQuoteResponse {
  optionSymbol: string;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume: number;
  openInterest: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  updated: number;
}

export class MarketDataError extends Error {
  constructor(
    message: string,
    public readonly apiStatus?: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'MarketDataError';
  }
}

// ---------------------------------------------------------------------------
// Semaphore – simple concurrency limiter (no external deps)
// ---------------------------------------------------------------------------

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_BATCH_SIZE = 100;
const CONCURRENCY_LIMIT = 3;
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 250;

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Convert a Unix-seconds timestamp to YYYY-MM-DD. */
function epochToDateStr(epoch: number): string {
  const d = new Date(epoch * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MarketDataClient {
  private readonly http: AxiosInstance;
  private readonly log;
  private readonly semaphore = new Semaphore(CONCURRENCY_LIMIT);

  constructor(apiToken: string) {
    this.log = createChildLogger('marketdata');

    this.http = axios.create({
      baseURL: 'https://api.marketdata.app',
      timeout: 6_000,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'User-Agent': 'TradePartners-DataService/0.1',
      },
    });
  }

  // ---- public API ---------------------------------------------------------

  async getExpirations(symbol: string): Promise<string[]> {
    const data = await this.requestWithRetry<RawExpirationsResponse>(
      `/v1/options/expirations/${encodeURIComponent(symbol)}/`,
    );

    if (data.s !== 'ok' || !Array.isArray(data.expirations)) {
      this.log.error({ symbol, apiStatus: data.s }, 'Invalid expirations response');
      throw new MarketDataError(`Invalid expirations response for ${symbol}`, data.s);
    }

    return data.expirations;
  }

  async getOptionChain(
    symbol: string,
    expiration: string,
    side?: 'call' | 'put',
    opts?: { strikeLimit?: number; minBid?: number },
  ): Promise<MarketDataOptionContract[]> {
    const params: Record<string, string> = { expiration };
    if (side) params.side = side;
    if (opts?.strikeLimit) params.strikeLimit = String(opts.strikeLimit);
    if (opts?.minBid != null) params.minBid = String(opts.minBid);

    const data = await this.requestWithRetry<RawChainResponse>(
      `/v1/options/chain/${encodeURIComponent(symbol)}/`,
      params,
    );

    if (data.s !== 'ok' || !Array.isArray(data.optionSymbol)) {
      this.log.error({ symbol, expiration, apiStatus: data.s }, 'Invalid chain response');
      throw new MarketDataError(`Invalid chain response for ${symbol}`, data.s);
    }

    const count = data.optionSymbol.length;
    const contracts: MarketDataOptionContract[] = new Array(count);

    for (let i = 0; i < count; i++) {
      contracts[i] = {
        optionSymbol: data.optionSymbol[i],
        underlying: data.underlying[i],
        expiration: epochToDateStr(data.expiration[i]),
        side: data.side[i] as 'call' | 'put',
        strike: data.strike[i],
        bid: data.bid[i],
        ask: data.ask[i],
        mid: data.mid[i],
        last: data.last[i],
        volume: data.volume[i],
        openInterest: data.openInterest[i],
        iv: data.iv[i],
        delta: data.delta[i],
        gamma: data.gamma[i],
        theta: data.theta[i],
        vega: data.vega[i],
        updated: data.updated[i],
      };
    }

    this.log.info({ symbol, expiration, side, count }, 'Fetched option chain');
    return contracts;
  }

  async getOptionQuotes(optionSymbols: string[]): Promise<MarketDataQuoteResponse[]> {
    if (optionSymbols.length === 0) return [];

    const batches = chunk(optionSymbols, MAX_BATCH_SIZE);
    this.log.info(
      { totalSymbols: optionSymbols.length, batches: batches.length },
      'Fetching option quotes in batches',
    );

    const results = await Promise.all(
      batches.map((batch) => this.fetchQuoteBatchGuarded(batch)),
    );

    return results.flat();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const data = await this.requestWithRetry<{ s: string }>(
        '/v1/markets/status/',
      );
      return data.s === 'ok';
    } catch {
      return false;
    }
  }

  // ---- private ------------------------------------------------------------

  private async fetchQuoteBatchGuarded(
    symbols: string[],
  ): Promise<MarketDataQuoteResponse[]> {
    await this.semaphore.acquire();
    try {
      return await this.fetchQuoteBatch(symbols);
    } finally {
      this.semaphore.release();
    }
  }

  private async fetchQuoteBatch(
    symbols: string[],
  ): Promise<MarketDataQuoteResponse[]> {
    const joined = symbols.join(',');
    const data = await this.requestWithRetry<RawQuotesResponse>(
      `/v1/options/quotes/${encodeURIComponent(joined)}/`,
    );

    if (data.s !== 'ok' || !Array.isArray(data.optionSymbol)) {
      this.log.error({ symbolCount: symbols.length, apiStatus: data.s }, 'Invalid quotes response');
      throw new MarketDataError('Invalid quotes response', data.s);
    }

    const count = data.optionSymbol.length;
    const quotes: MarketDataQuoteResponse[] = new Array(count);

    for (let i = 0; i < count; i++) {
      quotes[i] = {
        optionSymbol: data.optionSymbol[i],
        bid: data.bid[i],
        ask: data.ask[i],
        mid: data.mid[i],
        last: data.last[i],
        volume: data.volume[i],
        openInterest: data.openInterest[i],
        iv: data.iv[i],
        delta: data.delta[i],
        gamma: data.gamma[i],
        theta: data.theta[i],
        vega: data.vega[i],
        updated: data.updated[i],
      };
    }

    return quotes;
  }

  private async requestWithRetry<T>(
    url: string,
    params?: Record<string, string>,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        this.log.warn({ attempt, delayMs: delay, url }, 'Retrying request');
        await new Promise((r) => setTimeout(r, delay));
      }

      const start = Date.now();
      try {
        const response = await this.http.get<T>(url, { params });
        const latency = Date.now() - start;
        this.log.info({ url, latencyMs: latency, attempt }, 'Request completed');
        return response.data;
      } catch (err) {
        const latency = Date.now() - start;
        lastError = err instanceof Error ? err : new Error(String(err));

        if (err instanceof AxiosError) {
          const status = err.response?.status;
          this.log.error(
            { url, status, latencyMs: latency, attempt, error: err.message },
            'HTTP request failed',
          );

          // Non-retryable client errors (except 429 Too Many Requests)
          if (status && status >= 400 && status < 500 && status !== 429) {
            throw new MarketDataError(
              `${url} responded with ${status}`,
              String(status),
              status,
            );
          }
        } else {
          this.log.error(
            { url, latencyMs: latency, attempt, error: String(err) },
            'Non-HTTP request error',
          );
        }
      }
    }

    throw lastError!;
  }
}
