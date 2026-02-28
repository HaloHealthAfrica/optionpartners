import { BasePoller } from './base-poller';
import { snapshotStore } from '../persistence/snapshot-store';
import type { DataOrchestrator } from '../services/data-orchestrator';

const IV_INTERVAL = 5 * 60 * 1000; // 5 min

export class IvPoller extends BasePoller {
  private symbols: Set<string>;

  constructor(
    private orchestrator: DataOrchestrator,
    symbols: string[] = ['SPY', 'QQQ', 'IWM'],
  ) {
    super({ name: 'iv', intervalMs: IV_INTERVAL });
    this.symbols = new Set(symbols.map((s) => s.toUpperCase()));
  }

  addSymbol(symbol: string): void {
    this.symbols.add(symbol.toUpperCase());
    this.log.info({ symbol, total: this.symbols.size }, 'Symbol added to IV poller');
  }

  removeSymbol(symbol: string): void {
    this.symbols.delete(symbol.toUpperCase());
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }

  protected async tick(): Promise<void> {
    const symbols = [...this.symbols];
    let succeeded = 0;
    let failed = 0;

    for (const symbol of symbols) {
      try {
        const result = await this.orchestrator.getIV(symbol);
        const data = result.data;

        await snapshotStore.saveIvSnapshot(symbol, {
          currentIV: data.currentIV,
          ivRank: data.ivRank,
          ivPercentile: data.ivPercentile,
          historicalIV30: data.historicalIV30,
          historicalIV60: data.historicalIV60,
          historicalIV90: data.historicalIV90,
        }, result.provider);

        this.log.info({
          symbol,
          ivRank: data.ivRank,
          ivPercentile: data.ivPercentile,
          currentIV: data.currentIV.toFixed(4),
        }, 'IV snapshot captured');

        succeeded++;
      } catch (err) {
        this.log.error(
          { symbol, error: err instanceof Error ? err.message : err },
          'IV poll failed',
        );
        failed++;
      }
    }

    this.log.info({ succeeded, failed, total: symbols.length }, 'IV poll cycle complete');
  }
}
