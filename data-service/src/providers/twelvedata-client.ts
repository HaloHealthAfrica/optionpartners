import { BaseProvider, ProviderError } from './base-provider';
import { config } from '../config';
import type {
  MarketDataProvider,
  ProviderName,
  ProviderCapabilities,
  Candle,
  Quote,
  OptionsChain,
  OptionsContract,
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

interface TDOptionsExpiration {
  meta: { symbol: string };
  dates: string[];
}

interface TDOptionContract {
  contract_name: string;
  option_id: string;
  last_trade_date: string;
  strike: number;
  last_price: number;
  bid: number;
  ask: number;
  change: number;
  percent_change: number;
  volume: number;
  open_interest: number;
  implied_volatility: number;
  in_the_money: boolean;
}

interface TDOptionsChainResponse {
  meta: { symbol: string; name: string };
  calls: TDOptionContract[];
  puts: TDOptionContract[];
}

function normCdf(x: number): number {
  if (x > 6) return 1;
  if (x < -6) return 0;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1.0 + sign * y);
}

function estimateGreeks(
  type: 'call' | 'put', S: number, K: number, T: number, sigma: number, r = 0.045,
): { delta: number; gamma: number; theta: number; vega: number } {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    const intrinsic = type === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
    return { delta: intrinsic, gamma: 0, theta: 0, vega: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const nd1 = normCdf(d1);
  const nd1pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  const delta = type === 'call' ? nd1 : nd1 - 1;
  const gamma = nd1pdf / (S * sigma * sqrtT);
  const theta = (-(S * nd1pdf * sigma) / (2 * sqrtT) -
    r * K * Math.exp(-r * T) * normCdf(type === 'call' ? d2 : -d2) * (type === 'call' ? 1 : -1)) / 365;
  const vega = S * nd1pdf * sqrtT / 100;
  return { delta, gamma, theta, vega };
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

const TD_OPTIONS_ENABLED = process.env.TD_OPTIONS_ENABLED === 'true';

export class TwelveDataClient extends BaseProvider implements MarketDataProvider {
  readonly name: ProviderName = 'twelvedata';
  readonly capabilities: ProviderCapabilities = {
    candles: true,
    quotes: true,
    optionsChain: TD_OPTIONS_ENABLED,
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
        optionsChain: TD_OPTIONS_ENABLED,
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

  async getOptionsChain(symbol: string, expiration?: string): Promise<OptionsChain> {
    let expirationDate = expiration;

    if (!expirationDate) {
      const expData = await this.request<TDOptionsExpiration>('GET', '/options/expiration', {
        symbol,
        apikey: config.twelveData.apiKey,
      });
      this.checkApiError(expData);

      if (!expData?.dates?.length) {
        throw new ProviderError(this.name, 'PARSE_ERROR', `No expiration dates for ${symbol}`);
      }

      // Pick the nearest future expiry
      const today = new Date().toISOString().split('T')[0];
      const futureExpiries = expData.dates.filter(d => d >= today).sort();
      expirationDate = futureExpiries[0] || expData.dates[expData.dates.length - 1];
    }

    const chainData = await this.request<TDOptionsChainResponse>('GET', '/options/chain', {
      symbol,
      expiration_date: expirationDate,
      apikey: config.twelveData.apiKey,
    });
    this.checkApiError(chainData);

    if (!chainData?.calls && !chainData?.puts) {
      throw new ProviderError(this.name, 'PARSE_ERROR', `Empty options chain for ${symbol}`);
    }

    const calls = chainData.calls || [];
    const puts = chainData.puts || [];
    const expirationSet = new Set<string>();
    expirationSet.add(expirationDate);

    // Infer underlying price from ATM strike (where call-put price diff is minimal)
    let underlyingPrice = 0;
    const callByStrike = new Map(calls.map(c => [c.strike, c]));
    let minDiff = Infinity;
    for (const put of puts) {
      const call = callByStrike.get(put.strike);
      if (call && call.bid > 0 && put.bid > 0) {
        const callMid = (call.bid + call.ask) / 2;
        const putMid = (put.bid + put.ask) / 2;
        const diff = Math.abs(callMid - putMid);
        if (diff < minDiff) {
          minDiff = diff;
          underlyingPrice = put.strike;
        }
      }
    }
    if (underlyingPrice === 0 && calls.length > 0) {
      let maxVol = 0;
      for (const c of [...calls, ...puts]) {
        if (c.volume > maxVol) { maxVol = c.volume; underlyingPrice = c.strike; }
      }
    }

    this.log.info({ symbol, expirationDate, underlyingPrice, calls: calls.length, puts: puts.length },
      'TwelveData options chain fetched');

    const now = Date.now();
    const expiryDate = new Date(expirationDate + 'T16:00:00Z');
    const T = Math.max(0, (expiryDate.getTime() - now) / (365.25 * 24 * 60 * 60 * 1000));

    const mapContract = (c: TDOptionContract, type: 'call' | 'put'): OptionsContract => {
      const bid = c.bid || 0;
      const ask = c.ask || 0;
      const mid = bid && ask ? (bid + ask) / 2 : c.last_price || 0;
      const iv = c.implied_volatility || 0;

      let greeks = { delta: 0, gamma: 0, theta: 0, vega: 0 };
      if (underlyingPrice > 0 && iv > 0 && T > 0) {
        greeks = estimateGreeks(type, underlyingPrice, c.strike, T, iv);
      }

      return {
        symbol: c.option_id || c.contract_name,
        underlyingSymbol: symbol,
        type,
        strike: c.strike,
        expiration: expirationDate!,
        bid,
        ask,
        mid,
        last: c.last_price || 0,
        volume: c.volume || 0,
        openInterest: c.open_interest || 0,
        impliedVolatility: iv,
        delta: Math.round(greeks.delta * 10000) / 10000,
        gamma: Math.round(greeks.gamma * 10000) / 10000,
        theta: Math.round(greeks.theta * 10000) / 10000,
        vega: Math.round(greeks.vega * 10000) / 10000,
      };
    };

    const contracts: OptionsContract[] = [
      ...calls.map(c => mapContract(c, 'call')),
      ...puts.map(c => mapContract(c, 'put')),
    ];

    this.log.info({ symbol, contracts: contracts.length }, 'Options chain parsed with Greeks');

    return {
      symbol,
      expirations: [...expirationSet],
      contracts,
      timestamp: Date.now(),
    };
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
