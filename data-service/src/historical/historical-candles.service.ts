import { createChildLogger } from '../utils/logger';
import { config } from '../config';
import { cacheManager } from '../cache';
import { rateLimiter } from '../services/rate-limiter';
import type { HistoricalCandle } from '../api/v1-schemas';

const log = createChildLogger('historical-candles');

type HistTf = '1m' | '5m' | '15m' | '1h' | '1d';

const TD_INTERVAL_MAP: Record<HistTf, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1h': '1h',
  '1d': '1day',
};

const MAX_CHUNK_DAYS: Record<HistTf, number> = {
  '1m': 5,
  '5m': 10,
  '15m': 15,
  '1h': 30,
  '1d': 30,
};

const CONCURRENCY_LIMIT = 2;

interface ChunkResult {
  candles: HistoricalCandle[];
  latencyMs: number;
  cached: boolean;
}

export interface FetchCandlesResult {
  candles: HistoricalCandle[];
  chunks: number;
  cached: boolean;
}

export async function fetchCandlesChunked(
  symbol: string,
  tf: HistTf,
  start: string,
  end: string,
): Promise<FetchCandlesResult> {
  const cacheKey = `${symbol}:${tf}:${start}:${end}`;
  const cached = await cacheManager.get<HistoricalCandle[]>('hist_candles', cacheKey);
  if (cached) {
    log.info({ symbol, tf, start, end, count: cached.data.length, cacheSource: cached.source }, 'Historical candles cache hit');
    return { candles: cached.data, chunks: 0, cached: true };
  }

  const chunks = buildChunks(start, end, MAX_CHUNK_DAYS[tf]);
  log.info({ symbol, tf, start, end, chunkCount: chunks.length }, 'Fetching historical candles in chunks');

  const allCandles: HistoricalCandle[] = [];
  let idx = 0;

  while (idx < chunks.length) {
    const batch = chunks.slice(idx, idx + CONCURRENCY_LIMIT);
    const results = await Promise.allSettled(
      batch.map((chunk) => fetchChunk(symbol, tf, chunk.start, chunk.end)),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        allCandles.push(...r.value.candles);
        log.debug({ symbol, latencyMs: r.value.latencyMs, count: r.value.candles.length }, 'Chunk fetched');
      } else {
        log.error({ symbol, error: r.reason instanceof Error ? r.reason.message : r.reason }, 'Chunk fetch failed');
      }
    }

    idx += CONCURRENCY_LIMIT;
  }

  // Deduplicate by timestamp, sort ascending
  const seen = new Set<number>();
  const deduped: HistoricalCandle[] = [];
  allCandles.sort((a, b) => a.t - b.t);
  for (const c of allCandles) {
    if (!seen.has(c.t)) {
      seen.add(c.t);
      deduped.push(c);
    }
  }

  log.info({ symbol, tf, totalCandles: deduped.length, chunks: chunks.length }, 'Historical candles fetch complete');

  await cacheManager.set('hist_candles', cacheKey, deduped);

  return { candles: deduped, chunks: chunks.length, cached: false };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface DateChunk {
  start: string;
  end: string;
}

function buildChunks(start: string, end: string, maxDays: number): DateChunk[] {
  const chunks: DateChunk[] = [];
  let cur = new Date(start);
  const endDate = new Date(end);

  while (cur < endDate) {
    const chunkEnd = new Date(cur);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());

    chunks.push({
      start: cur.toISOString().slice(0, 10),
      end: chunkEnd.toISOString().slice(0, 10),
    });

    cur = new Date(chunkEnd);
    cur.setDate(cur.getDate() + 1);
  }

  return chunks;
}

async function fetchChunk(
  symbol: string,
  tf: HistTf,
  start: string,
  end: string,
): Promise<ChunkResult> {
  await rateLimiter.acquire('twelvedata');

  const interval = TD_INTERVAL_MAP[tf];
  const url = `${config.twelveData.baseUrl}/time_series`;
  const params = new URLSearchParams({
    symbol,
    interval,
    start_date: start,
    end_date: end,
    outputsize: '5000',
    apikey: config.twelveData.apiKey,
  });

  const t0 = Date.now();

  const response = await fetch(`${url}?${params.toString()}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`TwelveData HTTP ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    status?: string;
    values?: Array<{
      datetime: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }>;
  };

  const latencyMs = Date.now() - t0;

  if (!data.values || !Array.isArray(data.values)) {
    return { candles: [], latencyMs, cached: false };
  }

  const now = Date.now();
  const candles: HistoricalCandle[] = data.values.map((v) => ({
    t: new Date(v.datetime).getTime(),
    o: parseFloat(v.open),
    h: parseFloat(v.high),
    l: parseFloat(v.low),
    c: parseFloat(v.close),
    v: parseInt(v.volume, 10) || undefined,
    source: 'TWELVEDATA' as const,
    ts: now,
  }));

  return { candles, latencyMs, cached: false };
}
