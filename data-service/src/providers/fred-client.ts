import axios, { AxiosInstance } from 'axios';
import { createChildLogger } from '../utils/logger';
import { config } from '../config';
import type { ProviderName } from '../types';

const log = createChildLogger('fred');

interface FredSeriesResponse {
  observations: Array<{
    date: string;
    value: string;
  }>;
}

export interface MacroObservation {
  date: string;
  value: number;
}

// Known FOMC meeting dates for 2025-2026 (updated annually)
const FOMC_DATES_2025_2026 = [
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
  '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-17',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-16',
];

/**
 * Federal Reserve Economic Data (FRED) client.
 * Provides macro context: fed funds rate, yield curve, FOMC calendar.
 * Free API, low-frequency polling (daily).
 */
export class FredClient {
  readonly name: ProviderName = 'fred';
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.fred.baseUrl,
      timeout: 10_000,
      headers: { 'User-Agent': 'TradePartners-DataService/0.1' },
    });
  }

  async getFedFundsRate(): Promise<MacroObservation | null> {
    return this.getLatestObservation('FEDFUNDS');
  }

  async getYield2y(): Promise<MacroObservation | null> {
    return this.getLatestObservation('DGS2');
  }

  async getYield10y(): Promise<MacroObservation | null> {
    return this.getLatestObservation('DGS10');
  }

  async getYieldSpread(): Promise<MacroObservation | null> {
    return this.getLatestObservation('T10Y2Y');
  }

  getNextFomcDate(): string | null {
    const today = new Date().toISOString().split('T')[0];
    return FOMC_DATES_2025_2026.find((d) => d >= today) ?? null;
  }

  getDaysUntilFomc(): number | null {
    const next = this.getNextFomcDate();
    if (!next) return null;
    const diff = new Date(next).getTime() - Date.now();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  }

  async getAllMacroData(): Promise<{
    fedFundsRate: number | null;
    yield2y: number | null;
    yield10y: number | null;
    yieldSpread: number | null;
    nextFomc: string | null;
    daysUntilFomc: number | null;
    yieldCurveInverted: boolean;
  }> {
    const [ffr, y2, y10, spread] = await Promise.all([
      this.getFedFundsRate(),
      this.getYield2y(),
      this.getYield10y(),
      this.getYieldSpread(),
    ]);

    const yieldSpreadVal = spread?.value ?? null;
    const y2Val = y2?.value ?? null;
    const y10Val = y10?.value ?? null;

    return {
      fedFundsRate: ffr?.value ?? null,
      yield2y: y2Val,
      yield10y: y10Val,
      yieldSpread: yieldSpreadVal,
      nextFomc: this.getNextFomcDate(),
      daysUntilFomc: this.getDaysUntilFomc(),
      yieldCurveInverted: yieldSpreadVal !== null ? yieldSpreadVal < 0 : false,
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!config.fred.apiKey) return false;
    try {
      await this.getLatestObservation('FEDFUNDS');
      return true;
    } catch {
      return false;
    }
  }

  private async getLatestObservation(seriesId: string): Promise<MacroObservation | null> {
    if (!config.fred.apiKey) {
      log.debug({ seriesId }, 'FRED API key not configured');
      return null;
    }

    try {
      const { data } = await this.http.get<FredSeriesResponse>('/fred/series/observations', {
        params: {
          series_id: seriesId,
          api_key: config.fred.apiKey,
          file_type: 'json',
          sort_order: 'desc',
          limit: 5,
        },
      });

      const valid = data.observations?.find((o) => o.value !== '.');
      if (!valid) return null;

      return {
        date: valid.date,
        value: parseFloat(valid.value),
      };
    } catch (err) {
      log.warn({ seriesId, error: err instanceof Error ? err.message : err }, 'FRED fetch failed');
      return null;
    }
  }
}
