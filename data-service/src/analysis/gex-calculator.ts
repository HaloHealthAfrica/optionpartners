import { createChildLogger } from '../utils/logger';
import type { OptionsChain, GexData, GexLevel } from '../types';

const log = createChildLogger('gex-calculator');

const CONTRACT_MULTIPLIER = 100;
const TOP_LEVELS = 20;

interface StrikeGex {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
}

/**
 * Compute GEX (Gamma Exposure) from an options chain.
 *
 * For each strike:
 *   Call GEX = OI × gamma × spot × 100
 *   Put GEX  = −OI × gamma × spot × 100   (negative: MMs are typically short puts)
 *   Net GEX  = Call GEX + Put GEX
 *
 * Uses only the chain data already fetched — zero additional API calls.
 */
export function computeGex(chain: OptionsChain, spotPrice: number): GexData | null {
  if (!chain.contracts?.length || spotPrice <= 0) {
    log.warn({ symbol: chain.symbol, contracts: chain.contracts?.length, spotPrice }, 'Insufficient data for GEX');
    return null;
  }

  const strikeMap = new Map<number, { callGex: number; putGex: number }>();

  for (const c of chain.contracts) {
    const gamma = c.gamma ?? 0;
    const oi = c.openInterest ?? 0;
    if (gamma === 0 || oi === 0) continue;

    const dollarGamma = oi * Math.abs(gamma) * spotPrice * CONTRACT_MULTIPLIER;

    const entry = strikeMap.get(c.strike) ?? { callGex: 0, putGex: 0 };
    if (c.type === 'call') {
      entry.callGex += dollarGamma;
    } else {
      entry.putGex -= dollarGamma;
    }
    strikeMap.set(c.strike, entry);
  }

  if (strikeMap.size === 0) {
    log.warn({ symbol: chain.symbol }, 'No strikes with valid gamma × OI');
    return null;
  }

  const strikes: StrikeGex[] = [];
  let totalCallGex = 0;
  let totalPutGex = 0;

  for (const [strike, { callGex, putGex }] of strikeMap) {
    const netGex = callGex + putGex;
    strikes.push({ strike, callGex, putGex, netGex });
    totalCallGex += callGex;
    totalPutGex += putGex;
  }

  const netGex = totalCallGex + totalPutGex;

  // Find flip price: where cumulative net GEX changes sign
  const sortedByStrike = [...strikes].sort((a, b) => a.strike - b.strike);
  let flipPrice: number | null = null;
  for (let i = 1; i < sortedByStrike.length; i++) {
    const prev = sortedByStrike[i - 1];
    const curr = sortedByStrike[i];
    if (prev.netGex * curr.netGex < 0) {
      // Linear interpolation between the two strikes
      const ratio = Math.abs(prev.netGex) / (Math.abs(prev.netGex) + Math.abs(curr.netGex));
      flipPrice = prev.strike + ratio * (curr.strike - prev.strike);
      break;
    }
  }

  // Top levels by absolute net GEX
  const sorted = [...strikes].sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex));
  const majorLevels: GexLevel[] = sorted.slice(0, TOP_LEVELS).map(s => ({
    strike: s.strike,
    gex: s.netGex,
    callGex: s.callGex,
    putGex: s.putGex,
    type: classifyLevel(s, flipPrice, spotPrice),
  }));

  log.info(
    { symbol: chain.symbol, strikes: strikeMap.size, netGex: Math.round(netGex), flipPrice: flipPrice?.toFixed(2) },
    'GEX computed from chain data',
  );

  return {
    symbol: chain.symbol,
    totalGex: totalCallGex + Math.abs(totalPutGex),
    callGex: totalCallGex,
    putGex: totalPutGex,
    netGex,
    flipPrice,
    majorLevels,
    timestamp: Date.now(),
  };
}

function classifyLevel(s: StrikeGex, flipPrice: number | null, spotPrice: number): GexLevel['type'] {
  if (flipPrice && Math.abs(s.strike - flipPrice) < spotPrice * 0.005) return 'flip';
  if (s.netGex > 0 && s.callGex > Math.abs(s.putGex)) return 'resistance';
  if (s.netGex > 0 && Math.abs(s.putGex) > s.callGex) return 'support';
  return 'pin';
}
