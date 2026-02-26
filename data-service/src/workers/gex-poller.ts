import { BasePoller } from './base-poller';
import type { DataOrchestrator } from '../services/data-orchestrator';

const RTH_INTERVAL = 2 * 60 * 1000;  // 2 min
const ETH_INTERVAL = 5 * 60 * 1000;  // 5 min

export class GexPoller extends BasePoller {
  private symbols: Set<string>;

  constructor(
    private orchestrator: DataOrchestrator,
    symbols: string[] = ['SPY', 'QQQ', 'IWM'],
  ) {
    super({ name: 'gex', intervalMs: RTH_INTERVAL });
    this.symbols = new Set(symbols.map((s) => s.toUpperCase()));
  }

  addSymbol(symbol: string): void {
    this.symbols.add(symbol.toUpperCase());
    this.log.info({ symbol, total: this.symbols.size }, 'Symbol added to GEX poller');
  }

  removeSymbol(symbol: string): void {
    this.symbols.delete(symbol.toUpperCase());
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }

  setMarketHoursInterval(isRTH: boolean): void {
    const interval = isRTH ? RTH_INTERVAL : ETH_INTERVAL;
    if (interval !== this.config.intervalMs) {
      this.updateInterval(interval);
      this.log.info({ isRTH, intervalMs: interval }, 'GEX poller interval updated');
    }
  }

  protected async tick(): Promise<void> {
    const symbols = [...this.symbols];
    const results = await Promise.allSettled(
      symbols.map((symbol) => this.orchestrator.getGEXWithSnapshot(symbol)),
    );

    let succeeded = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') succeeded++;
      else failed++;
    }

    this.log.info({ succeeded, failed, total: symbols.length }, 'GEX poll cycle complete');
  }
}
