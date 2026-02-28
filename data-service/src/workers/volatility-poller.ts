import { BasePoller } from './base-poller';
import { buildDerivedMetrics, detectRegime } from '../analytics/regime.service';
import { validateCandles } from '../analytics/candle-validation';
import { snapshotStore } from '../persistence/snapshot-store';
import type { DataOrchestrator } from '../services/data-orchestrator';

const POST_CLOSE_INTERVAL = 4 * 60 * 60 * 1000;
const CANDLE_LOOKBACK = 252;

export class VolatilityPoller extends BasePoller {
  private symbols: Set<string>;
  private lastComputeDate: string | null = null;
  private midDayDone = false;

  constructor(
    private orchestrator: DataOrchestrator,
    symbols: string[] = ['SPY', 'QQQ', 'IWM'],
  ) {
    super({ name: 'volatility', intervalMs: POST_CLOSE_INTERVAL });
    this.symbols = new Set(symbols.map((s) => s.toUpperCase()));
  }

  addSymbol(symbol: string): void {
    this.symbols.add(symbol.toUpperCase());
  }

  removeSymbol(symbol: string): void {
    this.symbols.delete(symbol.toUpperCase());
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }

  protected async tick(): Promise<void> {
    if (!this.shouldRun()) {
      this.log.debug('Skipping volatility tick — not in scheduled window');
      return;
    }

    const symbols = [...this.symbols];
    let succeeded = 0;
    let failed = 0;

    for (const symbol of symbols) {
      try {
        const result = await this.orchestrator.getCandles(symbol, '1day', CANDLE_LOOKBACK);
        const candles = result.data;

        if (!Array.isArray(candles) || candles.length < 60) {
          this.log.warn({ symbol, count: Array.isArray(candles) ? candles.length : 0 },
            'Insufficient candle data for volatility computation');
          failed++;
          continue;
        }

        const validation = validateCandles(candles, CANDLE_LOOKBACK);
        if (!validation.valid) {
          this.log.error({ symbol, errors: validation.errors },
            'Candle validation failed — skipping snapshot');
          failed++;
          continue;
        }

        const metrics = buildDerivedMetrics(symbol, candles);
        const snapshot = detectRegime(metrics, candles);

        await snapshotStore.saveVolatilitySnapshot(snapshot);

        this.log.info({
          symbol,
          regime: snapshot.regime,
          candleCount: candles.length,
          hv20: metrics.hv20.toFixed(4),
          hv60: metrics.hv60.toFixed(4),
          hvPercentile: metrics.hvPercentile252.toFixed(2),
          atr14: metrics.atr14.toFixed(4),
          atr30: metrics.atr30.toFixed(4),
          analyticsVersion: snapshot.analyticsVersion,
        }, 'Volatility regime computed');

        succeeded++;
      } catch (err) {
        this.log.error({ symbol, error: err instanceof Error ? err.message : err },
          'Volatility computation failed');
        failed++;
      }
    }

    this.log.info({ succeeded, failed, total: symbols.length }, 'Volatility poll cycle complete');

    const today = new Date().toISOString().slice(0, 10);
    if (this.isPostClose()) {
      this.lastComputeDate = today;
      this.midDayDone = false;
    } else {
      this.midDayDone = true;
    }
  }

  /**
   * Run once after market close (primary), optional midday refresh at ~12:00 ET.
   * If market is closed (weekend/holiday), skip repeated fetches.
   */
  private shouldRun(): boolean {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    const totalUtcMin = utcHour * 60 + utcMin;
    const day = now.getUTCDay();
    const today = now.toISOString().slice(0, 10);

    const isWeekday = day >= 1 && day <= 5;
    if (!isWeekday) return false;

    // Post-close window: 16:15–17:00 ET ≈ 21:15–22:00 UTC (EST) / 20:15–21:00 UTC (EDT)
    const isPostClose = totalUtcMin >= 1275 && totalUtcMin < 1320;
    if (isPostClose && this.lastComputeDate !== today) return true;

    // Midday window: ~12:00 ET ≈ 17:00 UTC (EST) / 16:00 UTC (EDT)
    const isMidDay = totalUtcMin >= 960 && totalUtcMin < 1020;
    if (isMidDay && !this.midDayDone && this.lastComputeDate !== today) return true;

    // First run ever — allow it
    if (this.lastComputeDate === null) return true;

    return false;
  }

  private isPostClose(): boolean {
    const now = new Date();
    const totalUtcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    return totalUtcMin >= 1275 && totalUtcMin < 1320;
  }
}

export { validateCandles } from '../analytics/candle-validation';
