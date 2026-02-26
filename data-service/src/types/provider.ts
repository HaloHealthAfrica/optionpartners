import type {
  Candle,
  Quote,
  OptionsChain,
  GexData,
  OptionsFlowSummary,
  IVData,
  MarketHours,
  Timeframe,
} from './market-data';

export type ProviderName = 'twelvedata' | 'unusual_whales' | 'polygon' | 'cboe' | 'fred';

export type ProviderPriority = 'primary' | 'secondary' | 'tertiary';

export interface ProviderCapabilities {
  candles: boolean;
  quotes: boolean;
  optionsChain: boolean;
  gex: boolean;
  flow: boolean;
  iv: boolean;
  vix: boolean;
  marketHours: boolean;
}

export interface ProviderHealth {
  name: ProviderName;
  healthy: boolean;
  circuitState: 'closed' | 'open' | 'half-open';
  successRate: number;
  avgLatencyMs: number;
  rateLimitRemaining: number;
  rateLimitMax: number;
  lastSuccess: number | null;
  lastFailure: number | null;
  consecutiveFailures: number;
}

export interface ProviderConfig {
  name: ProviderName;
  priority: ProviderPriority;
  apiKey?: string;
  baseUrl: string;
  rateLimit: number;
  rateLimitWindow: number;
  capabilities: ProviderCapabilities;
  circuitBreaker: {
    failureThreshold: number;
    resetTimeoutMs: number;
    halfOpenMaxAttempts: number;
  };
}

export interface MarketDataProvider {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;

  getQuote(symbol: string): Promise<Quote>;
  getCandles(symbol: string, timeframe: Timeframe, limit?: number): Promise<Candle[]>;
  getMarketHours?(): Promise<MarketHours>;

  getOptionsChain?(symbol: string, expiration?: string): Promise<OptionsChain>;
  getGEX?(symbol: string): Promise<GexData>;
  getFlow?(symbol: string): Promise<OptionsFlowSummary>;
  getIV?(symbol: string): Promise<IVData>;

  healthCheck(): Promise<boolean>;
}

export interface ProviderResponse<T> {
  data: T;
  provider: ProviderName;
  cached: boolean;
  latencyMs: number;
  timestamp: number;
}
