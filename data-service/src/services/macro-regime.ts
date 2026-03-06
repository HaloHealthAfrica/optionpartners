import { createChildLogger } from '../utils/logger';
import { CboeClient } from '../providers/cboe-client';
import { FredClient } from '../providers/fred-client';
import { cacheManager } from '../cache';
import { snapshotStore } from '../persistence';
import type { VixData, MarketRegime } from '../types';

const log = createChildLogger('macro-regime');

export interface MacroData {
  fedFundsRate: number | null;
  yield2y: number | null;
  yield10y: number | null;
  yieldSpread: number | null;
  nextFomc: string | null;
  daysUntilFomc: number | null;
  yieldCurveInverted: boolean;
}

export class MacroRegimeService {
  private lastVix: VixData | null = null;
  private lastMacro: MacroData | null = null;
  private vixHistory: number[] = [];
  private maxVixHistory = 50;

  constructor(
    private cboe: CboeClient,
    private fred: FredClient,
  ) {}

  async getVixData(): Promise<VixData> {
    const cached = await cacheManager.get<VixData>('vix', 'current');
    if (cached) {
      const validated = this.validateVixData(cached.data);
      return validated;
    }

    const data = await this.cboe.getVixData();
    const validated = this.validateVixData(data);
    this.lastVix = validated;
    this.vixHistory.push(validated.spot);
    if (this.vixHistory.length > this.maxVixHistory) this.vixHistory.shift();

    await cacheManager.set('vix', 'current', validated);
    await snapshotStore.saveVixSnapshot(validated);

    return validated;
  }

  /**
   * Defense-in-depth VIX validation. Ensures spot value is in index-point
   * format regardless of upstream normalization.
   */
  private validateVixData(data: VixData): VixData {
    if (data.spot > 0 && data.spot < 2.0) {
      const corrected = data.spot * 100;
      log.warn(
        { original: data.spot, corrected },
        'VIX spot appears to be in decimal format — applying ×100 correction',
      );
      return { ...data, spot: corrected };
    }
    return data;
  }

  async getMacroData(): Promise<MacroData> {
    if (this.lastMacro) {
      return this.lastMacro;
    }
    return this.refreshMacroData();
  }

  async refreshMacroData(): Promise<MacroData> {
    const data = await this.fred.getAllMacroData();
    this.lastMacro = data;

    await snapshotStore.saveMacroSnapshot(data);
    log.info({ data }, 'Macro data refreshed');

    return data;
  }

  async getMarketRegime(): Promise<MarketRegime> {
    const vix = this.lastVix ?? await this.getVixData();
    const macro = this.lastMacro ?? await this.getMacroData();

    const regime = this.classifyRegime(vix.spot);
    const vixTrend = this.computeVixTrend();
    const tradingBias = this.computeTradingBias(vix, regime, vixTrend, macro);

    return {
      vixLevel: vix.spot,
      vixTrend,
      termStructure: vix.termStructure,
      regime,
      tradingBias,
      timestamp: Date.now(),
    };
  }

  private classifyRegime(vixSpot: number): MarketRegime['regime'] {
    if (vixSpot < 15) return 'low-vol';
    if (vixSpot < 20) return 'normal';
    if (vixSpot < 30) return 'elevated';
    return 'crisis';
  }

  private computeVixTrend(): MarketRegime['vixTrend'] {
    if (this.vixHistory.length < 3) return 'stable';

    const recent = this.vixHistory.slice(-5);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const pctChange = (last - first) / first;

    if (pctChange > 0.1) return 'rising';
    if (pctChange < -0.1) return 'falling';
    return 'stable';
  }

  private computeTradingBias(
    vix: VixData,
    regime: MarketRegime['regime'],
    vixTrend: MarketRegime['vixTrend'],
    macro: MacroData,
  ): MarketRegime['tradingBias'] {
    let score = 0;

    // VIX regime scoring
    if (regime === 'low-vol') score += 2;
    if (regime === 'normal') score += 1;
    if (regime === 'elevated') score -= 1;
    if (regime === 'crisis') score -= 3;

    // VIX trend scoring
    if (vixTrend === 'falling') score += 1;
    if (vixTrend === 'rising') score -= 1;

    // Term structure: contango is normal/bullish, backwardation is fearful
    if (vix.termStructure === 'contango') score += 1;
    if (vix.termStructure === 'backwardation') score -= 2;

    // Yield curve: inversion historically precedes recessions
    if (macro.yieldCurveInverted) score -= 1;

    // FOMC proximity: reduce risk near major catalyst
    if (macro.daysUntilFomc !== null && macro.daysUntilFomc <= 2) score -= 1;

    if (score >= 2) return 'risk-on';
    if (score <= -2) return 'risk-off';
    return 'neutral';
  }
}
