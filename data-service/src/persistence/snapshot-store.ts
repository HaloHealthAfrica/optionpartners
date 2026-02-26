import { getPool } from './db';
import { createChildLogger } from '../utils/logger';
import type { GexData, OptionsFlowSummary, Candle, VixData } from '../types';
import type { MacroData } from '../services/macro-regime';

const log = createChildLogger('snapshot-store');

export class SnapshotStore {
  private available = false;

  setAvailable(available: boolean): void {
    this.available = available;
  }

  async saveGexSnapshot(data: GexData, provider: string): Promise<void> {
    if (!this.available) return;
    try {
      await getPool().query(
        `INSERT INTO gex_snapshots (symbol, total_gex, call_gex, put_gex, net_gex, flip_price, major_levels, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (symbol, captured_at) DO NOTHING`,
        [data.symbol, data.totalGex, data.callGex, data.putGex, data.netGex, data.flipPrice, JSON.stringify(data.majorLevels), provider],
      );
      log.debug({ symbol: data.symbol }, 'GEX snapshot saved');
    } catch (err) {
      log.warn({ symbol: data.symbol, error: err instanceof Error ? err.message : err }, 'Failed to save GEX snapshot');
    }
  }

  async saveFlowSnapshot(data: OptionsFlowSummary, provider: string): Promise<void> {
    if (!this.available) return;
    try {
      await getPool().query(
        `INSERT INTO options_flow_snapshots
         (symbol, total_premium, call_premium, put_premium, net_premium, call_volume, put_volume, put_call_ratio, sentiment, largest_trades, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (symbol, captured_at) DO NOTHING`,
        [
          data.symbol, data.totalPremium, data.callPremium, data.putPremium, data.netPremium,
          data.callVolume, data.putVolume, data.putCallRatio, data.sentiment,
          JSON.stringify(data.largestTrades), provider,
        ],
      );
      log.debug({ symbol: data.symbol }, 'Flow snapshot saved');
    } catch (err) {
      log.warn({ symbol: data.symbol, error: err instanceof Error ? err.message : err }, 'Failed to save flow snapshot');
    }
  }

  async saveCandles(symbol: string, timeframe: string, candles: Candle[], provider: string): Promise<void> {
    if (!this.available || candles.length === 0) return;
    try {
      const pool = getPool();
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let idx = 1;

      for (const c of candles) {
        placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`);
        values.push(symbol, timeframe, c.timestamp, c.open, c.high, c.low, c.close, c.volume);
        idx += 8;
      }

      await pool.query(
        `INSERT INTO candle_history (symbol, timeframe, timestamp, open, high, low, close, volume)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (symbol, timeframe, timestamp) DO NOTHING`,
        values,
      );
      log.debug({ symbol, timeframe, count: candles.length }, 'Candles persisted');
    } catch (err) {
      log.warn({ symbol, error: err instanceof Error ? err.message : err }, 'Failed to persist candles');
    }
  }

  async saveVixSnapshot(data: VixData): Promise<void> {
    if (!this.available) return;
    try {
      await getPool().query(
        `INSERT INTO vix_snapshots (spot, futures, term_structure) VALUES ($1, $2, $3)`,
        [data.spot, JSON.stringify(data.futures), data.termStructure],
      );
      log.debug('VIX snapshot saved');
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : err }, 'Failed to save VIX snapshot');
    }
  }

  async saveMacroSnapshot(data: MacroData): Promise<void> {
    if (!this.available) return;
    try {
      await getPool().query(
        `INSERT INTO macro_snapshots (fed_funds_rate, yield_2y, yield_10y, yield_spread, next_fomc, data)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [data.fedFundsRate, data.yield2y, data.yield10y, data.yieldSpread, data.nextFomc, JSON.stringify(data)],
      );
      log.debug('Macro snapshot saved');
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : err }, 'Failed to save macro snapshot');
    }
  }

  // --- Queries for historical data ---

  async getRecentGex(symbol: string, limit = 50): Promise<GexData[]> {
    if (!this.available) return [];
    const { rows } = await getPool().query(
      `SELECT symbol, total_gex, call_gex, put_gex, net_gex, flip_price, major_levels, captured_at
       FROM gex_snapshots WHERE symbol = $1 ORDER BY captured_at DESC LIMIT $2`,
      [symbol, limit],
    );
    return rows.map((r) => ({
      symbol: r.symbol,
      totalGex: r.total_gex,
      callGex: r.call_gex,
      putGex: r.put_gex,
      netGex: r.net_gex,
      flipPrice: r.flip_price,
      majorLevels: r.major_levels,
      timestamp: new Date(r.captured_at).getTime(),
    }));
  }

  async getRecentFlow(symbol: string, limit = 50): Promise<OptionsFlowSummary[]> {
    if (!this.available) return [];
    const { rows } = await getPool().query(
      `SELECT * FROM options_flow_snapshots WHERE symbol = $1 ORDER BY captured_at DESC LIMIT $2`,
      [symbol, limit],
    );
    return rows.map((r) => ({
      symbol: r.symbol,
      totalPremium: r.total_premium,
      callPremium: r.call_premium,
      putPremium: r.put_premium,
      netPremium: r.net_premium,
      callVolume: r.call_volume,
      putVolume: r.put_volume,
      putCallRatio: r.put_call_ratio,
      largestTrades: r.largest_trades,
      sentiment: r.sentiment,
      timestamp: new Date(r.captured_at).getTime(),
    }));
  }

  async getVixHistory(limit = 100): Promise<VixData[]> {
    if (!this.available) return [];
    const { rows } = await getPool().query(
      `SELECT spot, futures, term_structure, captured_at FROM vix_snapshots ORDER BY captured_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      spot: r.spot,
      futures: r.futures,
      termStructure: r.term_structure,
      timestamp: new Date(r.captured_at).getTime(),
    }));
  }
}

export const snapshotStore = new SnapshotStore();
