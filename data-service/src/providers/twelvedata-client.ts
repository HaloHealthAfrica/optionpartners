import { BaseProvider, ProviderError } from './base-provider';
import { config } from '../config';
import type {
  MarketDataProvider,
  ProviderName,
  ProviderCapabilities,
  Candle,
  Quote,
  MarketHours,
  Timeframe,
} from '../types';

interface TDTimeSeries {
  meta: { symbol: string; interval: string; type: string };
  values: Array<{
    datetime: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }>;
  status: string;
}

interface TDQuote {
  symbol: string;
  name: string;
  open: string;
  high: string;
  low: string;
  close: string;
  previous_close: string;
  change: string;
  percent_change: string;
  volume: string;
  timestamp: number;
}

interface TDErrorResponse {
  code: number;
  message: string;
  status: 'error';
}

interface TDMarketState {
  name: string;
  code: string;
  country: string;
  is_market_open: boolean;
  time_to_open: string;
  time_to_close: string;
}

const TIMEFRAME_MAP: Record<Timeframe, string> = {
  '1min': '1min',
  '5min': '5min',
  '15min': '15min',
  '30min': '30min',
  '1h': '1h',
  '4h': '4h',
  '1day': '1day',
  '1week': '1week',
};

export class TwelveDataClient extends BaseProvider implements MarketDataProvider {
  readonly name: ProviderName = 'twelvedata';
  readonly capabilities: ProviderCapabilities = {
    candles: true,
    quotes: true,
    optionsChain: false,
    gex: false,
    flow: false,
    iv: false,
    vix: false,
    marketHours: true,
  };

  constructor() {
    super({
      name: 'twelvedata',
      priority: 'primary',
      apiKey: config.twelveData.apiKey,
      baseUrl: config.twelveData.baseUrl,
      rateLimit: config.twelveData.rateLimit,
      rateLimitWindow: 60_000,
      capabilities: {
        candles: true,
        quotes: true,
        optionsChain: false,
        gex: false,
        flow: false,
        iv: false,
        vix: false,
        marketHours: true,
      },
      circuitBreaker: {
        failureThreshold: 5,
        resetTimeoutMs: 30_000,
        halfOpenMaxAttempts: 3,
      },
    });
  }

  async getQuote(symbol: string): Promise<Quote> {
    const data = await this.request<TDQuote>('GET', '/quote', {
      symbol,
      apikey: config.twelveData.apiKey,
    });

    this.checkApiError(data);

    if (!data || !data.close) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty quote response for ${symbol}`);
    }

    return {
      symbol: data.symbol,
      price: parseFloat(data.close),
      open: parseFloat(data.open),
      high: parseFloat(data.high),
      low: parseFloat(data.low),
      previousClose: parseFloat(data.previous_close),
      change: parseFloat(data.change),
      changePercent: parseFloat(data.percent_change),
      volume: parseInt(data.volume, 10),
      timestamp: data.timestamp * 1000,
    };
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit = 100): Promise<Candle[]> {
    const interval = TIMEFRAME_MAP[timeframe];

    const data = await this.request<TDTimeSeries>('GET', '/time_series', {
      symbol,
      interval,
      outputsize: limit,
      apikey: config.twelveData.apiKey,
    });

    this.checkApiError(data);

    if (!data?.values || !Array.isArray(data.values)) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Invalid candle response for ${symbol}`);
    }

    return data.values
      .map((v) => ({
        timestamp: new Date(v.datetime).getTime(),
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: parseInt(v.volume, 10),
      }))
      .reverse(); // TwelveData returns newest first
  }

  async getMarketHours(): Promise<MarketHours> {
    const data = await this.request<TDMarketState>('GET', '/market_state', {
      exchange: 'NYSE',
      apikey: config.twelveData.apiKey,
    });

    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const totalMinutes = hour * 60 + minute;

    // Pre-market: 4:00 - 9:30 ET (09:00 - 14:30 UTC)
    const isPreMarket = totalMinutes >= 540 && totalMinutes < 870;
    // After-hours: 16:00 - 20:00 ET (21:00 - 01:00 UTC)
    const isAfterHours = totalMinutes >= 1260 || totalMinutes < 60;

    return {
      isOpen: data.is_market_open,
      isPreMarket: !data.is_market_open && isPreMarket,
      isAfterHours: !data.is_market_open && isAfterHours,
      nextOpen: data.time_to_open || null,
      nextClose: data.time_to_close || null,
      holiday: null,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const data = await this.request<TDQuote>('GET', '/quote', {
        symbol: 'SPY',
        apikey: config.twelveData.apiKey,
      });
      this.checkApiError(data);
      return true;
    } catch {
      return false;
    }
  }

  private checkApiError(data: unknown): void {
    const err = data as TDErrorResponse;
    if (err && typeof err === 'object' && err.status === 'error') {
      const code = err.code === 401 || err.code === 403 ? 'AUTH_ERROR' : 'API_ERROR';
      throw new ProviderError(this.name, code, err.message || 'TwelveData API error', err.code);
    }
  }
}
