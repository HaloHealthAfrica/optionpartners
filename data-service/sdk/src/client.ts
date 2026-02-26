import axios, { AxiosInstance, AxiosError } from 'axios';
import type {
  DataClientConfig,
  ProviderResponse,
  HistoryResponse,
  Quote,
  Candle,
  OptionsChain,
  GexData,
  OptionsFlowSummary,
  IVData,
  VixData,
  MarketRegime,
  MacroData,
  MarketHours,
  HealthStatus,
  Timeframe,
} from './types';

const DEFAULT_CONFIG: Required<Pick<DataClientConfig, 'timeout' | 'maxRetries' | 'retryDelayMs'>> = {
  timeout: 15_000,
  maxRetries: 2,
  retryDelayMs: 500,
};

export class DataClient {
  private http: AxiosInstance;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(config: DataClientConfig) {
    const { baseUrl, apiKey, timeout, maxRetries, retryDelayMs } = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;

    this.http = axios.create({
      baseURL: baseUrl.replace(/\/$/, '') + '/api',
      timeout,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  // --- Stock / Price Data ---

  async getQuote(symbol: string): Promise<Quote> {
    const res = await this.get<ProviderResponse<Quote>>(`/quote/${symbol.toUpperCase()}`);
    return res.data;
  }

  async getCandles(
    symbol: string,
    timeframe: Timeframe = '5min',
    limit = 100,
  ): Promise<Candle[]> {
    const res = await this.get<ProviderResponse<Candle[]>>(
      `/candles/${symbol.toUpperCase()}`,
      { timeframe, limit },
    );
    return res.data;
  }

  async getMarketHours(): Promise<MarketHours> {
    const res = await this.get<ProviderResponse<MarketHours>>('/market-hours');
    return res.data;
  }

  // --- Options Intelligence ---

  async getOptionsChain(symbol: string, expiration?: string): Promise<OptionsChain> {
    const params: Record<string, string> = {};
    if (expiration) params.expiration = expiration;
    const res = await this.get<ProviderResponse<OptionsChain>>(
      `/options-chain/${symbol.toUpperCase()}`,
      params,
    );
    return res.data;
  }

  async getGEX(symbol: string): Promise<GexData> {
    const res = await this.get<ProviderResponse<GexData>>(`/gex/${symbol.toUpperCase()}`);
    return res.data;
  }

  async getFlow(symbol: string): Promise<OptionsFlowSummary> {
    const res = await this.get<ProviderResponse<OptionsFlowSummary>>(`/flow/${symbol.toUpperCase()}`);
    return res.data;
  }

  async getIV(symbol: string): Promise<IVData> {
    const res = await this.get<ProviderResponse<IVData>>(`/iv/${symbol.toUpperCase()}`);
    return res.data;
  }

  // --- VIX / Macro / Regime ---

  async getVIX(): Promise<VixData> {
    const res = await this.get<ProviderResponse<VixData>>('/vix');
    return res.data;
  }

  async getMarketRegime(): Promise<MarketRegime> {
    const res = await this.get<ProviderResponse<MarketRegime>>('/regime');
    return res.data;
  }

  async getMacroData(): Promise<MacroData> {
    const res = await this.get<ProviderResponse<MacroData>>('/macro');
    return res.data;
  }

  // --- Snapshot endpoints (fetch + persist to Postgres) ---

  async getGEXWithSnapshot(symbol: string): Promise<GexData> {
    const res = await this.get<ProviderResponse<GexData>>(`/gex/${symbol.toUpperCase()}/snapshot`);
    return res.data;
  }

  async getFlowWithSnapshot(symbol: string): Promise<OptionsFlowSummary> {
    const res = await this.get<ProviderResponse<OptionsFlowSummary>>(`/flow/${symbol.toUpperCase()}/snapshot`);
    return res.data;
  }

  // --- History endpoints (read from Postgres) ---

  async getGEXHistory(symbol: string, limit = 50): Promise<GexData[]> {
    const res = await this.get<HistoryResponse<GexData>>(
      `/history/gex/${symbol.toUpperCase()}`,
      { limit },
    );
    return res.data;
  }

  async getFlowHistory(symbol: string, limit = 50): Promise<OptionsFlowSummary[]> {
    const res = await this.get<HistoryResponse<OptionsFlowSummary>>(
      `/history/flow/${symbol.toUpperCase()}`,
      { limit },
    );
    return res.data;
  }

  async getVIXHistory(limit = 100): Promise<VixData[]> {
    const res = await this.get<HistoryResponse<VixData>>('/history/vix', { limit });
    return res.data;
  }

  // --- Health ---

  async getHealth(): Promise<HealthStatus> {
    return this.get<HealthStatus>('/health');
  }

  // --- Raw provider response access (includes metadata) ---

  async getRawQuote(symbol: string): Promise<ProviderResponse<Quote>> {
    return this.get<ProviderResponse<Quote>>(`/quote/${symbol.toUpperCase()}`);
  }

  async getRawCandles(
    symbol: string,
    timeframe: Timeframe = '5min',
    limit = 100,
  ): Promise<ProviderResponse<Candle[]>> {
    return this.get<ProviderResponse<Candle[]>>(
      `/candles/${symbol.toUpperCase()}`,
      { timeframe, limit },
    );
  }

  async getRawGEX(symbol: string): Promise<ProviderResponse<GexData>> {
    return this.get<ProviderResponse<GexData>>(`/gex/${symbol.toUpperCase()}`);
  }

  async getRawFlow(symbol: string): Promise<ProviderResponse<OptionsFlowSummary>> {
    return this.get<ProviderResponse<OptionsFlowSummary>>(`/flow/${symbol.toUpperCase()}`);
  }

  // --- Internal: HTTP with retry ---

  private async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.http.get<T>(path, { params });
        return response.data;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (err instanceof AxiosError) {
          const status = err.response?.status;
          // Don't retry client errors (except 429 rate limit)
          if (status && status >= 400 && status < 500 && status !== 429) {
            throw new DataServiceError(
              err.response?.data?.error || err.message,
              status,
              path,
            );
          }
        }

        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new DataServiceError(
      lastError?.message || 'Request failed after retries',
      0,
      path,
    );
  }
}

export class DataServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly path: string,
  ) {
    super(`DataService [${statusCode}] ${path}: ${message}`);
    this.name = 'DataServiceError';
  }
}
