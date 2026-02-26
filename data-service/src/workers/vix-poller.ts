import { BasePoller } from './base-poller';
import type { DataOrchestrator } from '../services/data-orchestrator';

const VIX_INTERVAL = 5 * 60 * 1000; // 5 min

export class VixPoller extends BasePoller {
  constructor(private orchestrator: DataOrchestrator) {
    super({ name: 'vix', intervalMs: VIX_INTERVAL });
  }

  protected async tick(): Promise<void> {
    try {
      const result = await this.orchestrator.getVIX();
      this.log.info(
        { spot: result.data.spot, termStructure: result.data.termStructure },
        'VIX data refreshed',
      );
    } catch (err) {
      this.log.error({ error: err instanceof Error ? err.message : err }, 'VIX poll failed');
    }
  }
}
