import axios, { AxiosInstance } from 'axios';
import { createChildLogger } from '../utils/logger';
import { rateLimiter } from '../services/rate-limiter';
import { config } from '../config';
import type { ProviderName, VixData, VixFuture } from '../types';

const log = createChildLogger('cboe');

interface CboeDelayedQuote {
  data: {
    symbol: string;
    last: number;
    change: number;
    percentChange: number;
    high: number;
    low: number;
    open: number;
    close: number;
    volume: number;
    tradeTime: string;
  };
}

interface CboeVixFuturesResponse {
  data: Array<{
    symbol: string;
    expirationDate: string;
    last: number;
    change: number;
    percentChange: number;
  }>;
}

/**
 * CBOE client for VIX spot + futures term structure.
 * Uses CBOE's free delayed quote CDN — no API key required.
 */
export class CboeClient {
  readonly name: ProviderName = 'cboe';
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.cboe.baseUrl,
      timeout: 10_000,
      headers: { 'User-Agent': 'TradePartners-DataService/0.1' },
    });

    rateLimiter.configure('cboe', config.cboe.rateLimit);
  }

  async getVixData(): Promise<VixData> {
    await rateLimiter.acquire('cboe');

    try {
      const [rawSpot, futuresRes] = await Promise.all([
        this.fetchVixSpot(),
        this.fetchVixFutures(),
      ]);

      const spotRes = this.normalizeVixValue(rawSpot);
      const termStructure = this.classifyTermStructure(spotRes, futuresRes);

      return {
        spot: spotRes,
        futures: futuresRes,
        termStructure,
        timestamp: Date.now(),
      };
    } catch (err) {
      log.error({ error: err instanceof Error ? err.message : err }, 'Failed to fetch VIX data');
      throw err;
    }
  }

  /**
   * Normalize VIX value to standard index-point format (e.g. 25.9).
   * Some feeds deliver VIX as a decimal fraction (0.259 instead of 25.9).
   * VIX has never closed below 9.14 historically, so any value < 5.0
   * is almost certainly a decimal representation requiring ×100 correction.
   * Values > 100 are also flagged as suspect (VIX rarely exceeds 90).
   */
  normalizeVixValue(raw: number): number {
    if (raw <= 0) {
      log.warn({ raw }, 'VIX value is zero or negative — returning as-is');
      return raw;
    }

    if (raw < 2.0) {
      const corrected = raw * 100;
      log.warn(
        { raw, corrected },
        'VIX unit correction applied: raw value < 2.0 indicates decimal format, multiplying by 100',
      );
      return corrected;
    }

    if (raw > 150) {
      log.warn({ raw }, 'VIX value suspiciously high (>150) — possible data error');
    }

    return raw;
  }

  private async fetchVixSpot(): Promise<number> {
    try {
      const { data } = await this.http.get<CboeDelayedQuote>(
        '/api/delayed_quotes/VIX',
      );
      return data.data.last;
    } catch {
      // Fallback: try the indices endpoint
      const { data } = await this.http.get<CboeDelayedQuote>(
        '/api/delayed_quotes/indices/VIX',
      );
      return data.data.last;
    }
  }

  private async fetchVixFutures(): Promise<VixFuture[]> {
    try {
      const { data } = await this.http.get<CboeVixFuturesResponse>(
        '/api/delayed_quotes/futures?rootSymbol=VX',
      );

      if (!data?.data || !Array.isArray(data.data)) {
        log.warn('No VIX futures data returned');
        return [];
      }

      return data.data
        .filter((f) => f.last > 0)
        .map((f) => {
          const expDate = new Date(f.expirationDate);
          return {
            month: expDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
            expiration: f.expirationDate,
            price: f.last,
            change: f.change,
          };
        })
        .sort((a, b) => new Date(a.expiration).getTime() - new Date(b.expiration).getTime());
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : err }, 'VIX futures fetch failed');
      return [];
    }
  }

  private classifyTermStructure(
    spot: number,
    futures: VixFuture[],
  ): 'contango' | 'backwardation' | 'flat' {
    if (futures.length < 2) return 'flat';

    const frontMonth = futures[0].price;
    const secondMonth = futures.length > 1 ? futures[1].price : frontMonth;

    // Compare spot to front month and front to second
    const spotVsFront = (frontMonth - spot) / spot;
    const frontVsSecond = (secondMonth - frontMonth) / frontMonth;

    // Contango: futures > spot (normal VIX curve)
    if (spotVsFront > 0.02 && frontVsSecond > 0.01) return 'contango';
    // Backwardation: spot > futures (fear/crisis)
    if (spotVsFront < -0.02) return 'backwardation';

    return 'flat';
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.http.get('/api/delayed_quotes/VIX');
      return true;
    } catch {
      return false;
    }
  }
}
