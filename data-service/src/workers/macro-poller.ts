import { BasePoller } from './base-poller';
import type { MacroRegimeService } from '../services/macro-regime';

const MACRO_INTERVAL = 60 * 60 * 1000; // 1 hour (FRED data updates daily, no need to poll faster)

export class MacroPoller extends BasePoller {
  constructor(private macroRegime: MacroRegimeService) {
    super({ name: 'macro', intervalMs: MACRO_INTERVAL });
  }

  protected async tick(): Promise<void> {
    try {
      const data = await this.macroRegime.refreshMacroData();
      this.log.info(
        {
          fedFundsRate: data.fedFundsRate,
          yieldSpread: data.yieldSpread,
          nextFomc: data.nextFomc,
          daysUntilFomc: data.daysUntilFomc,
        },
        'Macro data refreshed',
      );
    } catch (err) {
      this.log.error({ error: err instanceof Error ? err.message : err }, 'Macro poll failed');
    }
  }
}
