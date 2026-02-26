export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  price: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: number;
}

export interface OptionsContract {
  symbol: string;
  underlyingSymbol: string;
  type: 'call' | 'put';
  strike: number;
  expiration: string;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface OptionsChain {
  symbol: string;
  expirations: string[];
  contracts: OptionsContract[];
  timestamp: number;
}

export interface GexLevel {
  strike: number;
  gex: number;
  callGex: number;
  putGex: number;
  type: 'support' | 'resistance' | 'pin' | 'flip';
}

export interface GexData {
  symbol: string;
  totalGex: number;
  callGex: number;
  putGex: number;
  netGex: number;
  flipPrice: number | null;
  majorLevels: GexLevel[];
  timestamp: number;
}

export interface OptionsFlowTick {
  symbol: string;
  contractSymbol: string;
  type: 'call' | 'put';
  strike: number;
  expiration: string;
  side: 'bid' | 'ask' | 'mid';
  sentiment: 'bullish' | 'bearish' | 'neutral';
  premium: number;
  size: number;
  openInterest: number;
  volume: number;
  impliedVolatility: number;
  timestamp: number;
}

export interface OptionsFlowSummary {
  symbol: string;
  totalPremium: number;
  callPremium: number;
  putPremium: number;
  netPremium: number;
  callVolume: number;
  putVolume: number;
  putCallRatio: number;
  largestTrades: OptionsFlowTick[];
  sentiment: 'bullish' | 'bearish' | 'neutral';
  timestamp: number;
}

export interface IVData {
  symbol: string;
  currentIV: number;
  ivRank: number;
  ivPercentile: number;
  historicalIV30: number;
  historicalIV60: number;
  historicalIV90: number;
  timestamp: number;
}

export interface VixFuture {
  month: string;
  expiration: string;
  price: number;
  change: number;
}

export interface VixData {
  spot: number;
  futures: VixFuture[];
  termStructure: 'contango' | 'backwardation' | 'flat';
  timestamp: number;
}

export interface MarketRegime {
  vixLevel: number;
  vixTrend: 'rising' | 'falling' | 'stable';
  termStructure: 'contango' | 'backwardation' | 'flat';
  regime: 'low-vol' | 'normal' | 'elevated' | 'crisis';
  tradingBias: 'risk-on' | 'neutral' | 'risk-off';
  timestamp: number;
}

export interface MacroData {
  fedFundsRate: number | null;
  yield2y: number | null;
  yield10y: number | null;
  yieldSpread: number | null;
  nextFomc: string | null;
  daysUntilFomc: number | null;
  yieldCurveInverted: boolean;
}

export interface MarketHours {
  isOpen: boolean;
  isPreMarket: boolean;
  isAfterHours: boolean;
  nextOpen: string | null;
  nextClose: string | null;
  holiday: string | null;
}

export interface ProviderResponse<T> {
  data: T;
  provider: string;
  cached: boolean;
  latencyMs: number;
  timestamp: number;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded';
  uptime: number;
  providers: ProviderHealth[];
  liveChecks: Record<string, boolean | null>;
  infrastructure: {
    database: boolean;
    snapshotsEnabled: boolean;
  };
  timestamp: number;
}

export interface ProviderHealth {
  name: string;
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

export interface HistoryResponse<T> {
  data: T[];
  count: number;
}

export type Timeframe = '1min' | '5min' | '15min' | '30min' | '1h' | '4h' | '1day' | '1week';

export interface DataClientConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}
