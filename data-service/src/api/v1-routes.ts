import { Router, Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { createChildLogger } from '../utils/logger';
import { parseCanonical } from '../contracts/canonical';
import type { DataOrchestrator } from '../services/data-orchestrator';
import type { MarketDataAdapter } from '../providers/marketdata/adapter';
import type { CacheManager } from '../cache/cache-manager';
import type { CircuitBreaker } from '../services/circuit-breaker';
import { ServiceUnavailableError } from '../providers/base-provider';

import {
  symbolParamSchema,
  chainQuerySchema,
  contractsBodySchema,
  underlyingQuoteResponseSchema,
  expirationsResponseSchema,
  chainResponseSchema,
  optionQuotesResponseSchema,
  greeksResponseSchema,
  sourcesResponseSchema,
  healthResponseSchema,
  historicalCandlesQuerySchema,
  historicalCandlesResponseSchema,
  metricsQuerySchema,
  derivedMetricsResponseSchema,
  regimeResultSchema,
  ivStubResponseSchema,
} from './v1-schemas';
import { fetchCandlesChunked } from '../historical/historical-candles.service';
import { computeMetrics, detectRegime } from '../analysis/regime-engine';
import { snapshotStore } from '../persistence/snapshot-store';

const log = createChildLogger('v1-routes');

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface V1RouteContext {
  orchestrator: DataOrchestrator;
  marketDataAdapter?: MarketDataAdapter;
  cacheManager: CacheManager;
  circuitBreaker: CircuitBreaker;
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorJson(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message, status, timestamp: Date.now() });
}

function requireAdapter(ctx: V1RouteContext, res: Response): ctx is V1RouteContext & { marketDataAdapter: MarketDataAdapter } {
  if (!ctx.marketDataAdapter) {
    errorJson(res, 503, 'MarketDataAdapter is unavailable');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createV1Routes(ctx: V1RouteContext): Router {
  const router = Router();

  // ---- Auth middleware ----------------------------------------------------

  router.use((req: Request, res: Response, next: NextFunction) => {
    const key = req.headers['x-internal-api-key'];
    if (!key || key !== ctx.apiKey) {
      errorJson(res, 401, 'Invalid or missing API key');
      return;
    }
    next();
  });

  // ---- Request logging middleware ----------------------------------------

  router.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      log.info({
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        latencyMs: Date.now() - start,
      }, 'request');
    });
    next();
  });

  // ---- GET /v1/underlying/:symbol/quote ----------------------------------

  router.get('/underlying/:symbol/quote', async (req: Request, res: Response) => {
    try {
      const { symbol } = symbolParamSchema.parse(req.params);
      const result = await ctx.orchestrator.getQuote(symbol);
      const body = underlyingQuoteResponseSchema.parse({
        symbol: result.data.symbol,
        price: result.data.price,
        change: result.data.change,
        changePercent: result.data.changePercent,
        volume: result.data.volume,
        timestamp: result.data.timestamp,
        source: result.provider,
      });
      res.json(body);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // ---- GET /v1/options/:symbol/expirations -------------------------------

  router.get('/options/:symbol/expirations', async (req: Request, res: Response) => {
    try {
      if (!requireAdapter(ctx, res)) return;
      const { symbol } = symbolParamSchema.parse(req.params);

      const cached = await ctx.cacheManager.get<string[]>('expirations', symbol);
      if (cached) {
        const body = expirationsResponseSchema.parse({
          symbol,
          expirations: cached.data,
          source: `cache:${cached.source}`,
        });
        res.json(body);
        return;
      }

      const expirations = await ctx.marketDataAdapter.getExpirations(symbol);
      await ctx.cacheManager.set('expirations', symbol, expirations);

      const body = expirationsResponseSchema.parse({
        symbol,
        expirations,
        source: 'marketdata',
      });
      res.json(body);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // ---- GET /v1/options/:symbol/chain -------------------------------------

  router.get('/options/:symbol/chain', async (req: Request, res: Response) => {
    try {
      if (!requireAdapter(ctx, res)) return;
      const { symbol } = symbolParamSchema.parse(req.params);
      const { exp, right } = chainQuerySchema.parse(req.query);

      const cacheKey = `${symbol}:${exp}:${right ?? 'all'}`;
      const cached = await ctx.cacheManager.get<unknown[]>('chain', cacheKey);
      if (cached) {
        const body = chainResponseSchema.parse({
          symbol,
          expiration: exp,
          contracts: cached.data,
          count: cached.data.length,
          source: `cache:${cached.source}`,
        });
        res.json(body);
        return;
      }

      const adapterRight = right ? (right.toLowerCase() as 'call' | 'put') : undefined;
      const contracts = await ctx.marketDataAdapter.getOptionsChain(symbol, exp, adapterRight);
      await ctx.cacheManager.set('chain', cacheKey, contracts);

      const body = chainResponseSchema.parse({
        symbol,
        expiration: exp,
        contracts,
        count: contracts.length,
        source: 'marketdata',
      });
      res.json(body);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // ---- POST /v1/options/quotes -------------------------------------------

  router.post('/options/quotes', async (req: Request, res: Response) => {
    try {
      if (!requireAdapter(ctx, res)) return;
      const { contracts } = contractsBodySchema.parse(req.body);

      const quotes = await ctx.marketDataAdapter.getOptionQuotes(contracts);

      const body = optionQuotesResponseSchema.parse({
        quotes,
        count: quotes.length,
      });
      res.json(body);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // ---- POST /v1/options/greeks -------------------------------------------

  router.post('/options/greeks', async (req: Request, res: Response) => {
    try {
      if (!requireAdapter(ctx, res)) return;
      const { contracts } = contractsBodySchema.parse(req.body);

      const groups = new Map<string, string[]>();
      for (const id of contracts) {
        const parts = parseCanonical(id);
        const expDashed = `${parts.expirationYYYYMMDD.slice(0, 4)}-${parts.expirationYYYYMMDD.slice(4, 6)}-${parts.expirationYYYYMMDD.slice(6, 8)}`;
        const key = `${parts.underlying}:${expDashed}`;
        let arr = groups.get(key);
        if (!arr) {
          arr = [];
          groups.set(key, arr);
        }
        arr.push(id);
      }

      const requestedSet = new Set(contracts);
      const greeks: Array<{
        canonicalId: string;
        iv: number;
        delta: number;
        gamma: number;
        theta: number;
        vega: number;
        updatedAt: number;
        source: string;
      }> = [];

      for (const [key, _ids] of groups) {
        const [underlying, exp] = key.split(':');
        const chainCacheKey = `${underlying}:${exp}:all`;

        const cached = await ctx.cacheManager.get<import('../providers/marketdata/adapter').NormalizedOptionContract[]>('chain', chainCacheKey);
        const chain = cached
          ? cached.data
          : await ctx.marketDataAdapter!.getOptionsChain(underlying, exp);

        if (!cached) {
          await ctx.cacheManager.set('chain', chainCacheKey, chain);
        }

        for (const c of chain) {
          if (requestedSet.has(c.canonicalId)) {
            greeks.push({
              canonicalId: c.canonicalId,
              iv: c.iv,
              delta: c.delta,
              gamma: c.gamma,
              theta: c.theta,
              vega: c.vega,
              updatedAt: c.updatedAt,
              source: c.source,
            });
          }
        }
      }

      const body = greeksResponseSchema.parse({ greeks, count: greeks.length });
      res.json(body);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // ---- GET /v1/historical/:symbol/candles --------------------------------

  router.get('/historical/:symbol/candles', async (req: Request, res: Response) => {
    try {
      const { symbol } = symbolParamSchema.parse(req.params);
      const { tf, start, end } = historicalCandlesQuerySchema.parse(req.query);

      const result = await fetchCandlesChunked(symbol, tf, start, end);

      const body = historicalCandlesResponseSchema.parse({
        symbol,
        timeframe: tf,
        start,
        end,
        candles: result.candles,
        count: result.candles.length,
        chunks: result.chunks,
        cached: result.cached,
        ts: Date.now(),
      });
      res.json(body);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // ---- GET /v1/historical/:symbol/metrics -------------------------------

  router.get('/historical/:symbol/metrics', async (req: Request, res: Response) => {
    try {
      const { symbol } = symbolParamSchema.parse(req.params);
      const { tf, lookback } = metricsQuerySchema.parse(req.query);

      const metrics = await computeMetrics(symbol, tf, lookback);

      const body = derivedMetricsResponseSchema.parse(metrics);
      res.json(body);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // ---- GET /v1/historical/:symbol/regime --------------------------------

  router.get('/historical/:symbol/regime', async (req: Request, res: Response) => {
    try {
      const { symbol } = symbolParamSchema.parse(req.params);
      const { tf, lookback } = metricsQuerySchema.parse(req.query);

      const regime = await detectRegime(symbol, tf, lookback);

      const body = regimeResultSchema.parse(regime);
      res.json(body);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // ---- GET /v1/historical/:symbol/iv ------------------------------------

  router.get('/historical/:symbol/iv', async (req: Request, res: Response) => {
    try {
      const { symbol } = symbolParamSchema.parse(req.params);
      const limit = parseInt((req.query.limit as string) || '100', 10);

      const data = await snapshotStore.getRecentIv(symbol, limit);

      if (data.length === 0) {
        res.json({
          symbol,
          data: [],
          count: 0,
          message: 'No IV snapshots yet. IV data accumulates via the IV poller. Call POST /api/seed to take an initial snapshot.',
          ts: Date.now(),
        });
        return;
      }

      res.json({
        symbol,
        data,
        count: data.length,
        ts: Date.now(),
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // ---- GET /v1/meta/sources ----------------------------------------------

  router.get('/meta/sources', async (_req: Request, res: Response) => {
    try {
      const providers = ctx.orchestrator.getProviderHealths();

      const body = sourcesResponseSchema.parse({
        providers: providers.map((p) => ({
          name: p.name,
          healthy: p.healthy,
          circuitState: p.circuitState,
          successRate: p.successRate,
          avgLatencyMs: p.avgLatencyMs,
        })),
        timestamp: Date.now(),
      });
      res.json(body);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // ---- GET /v1/health ----------------------------------------------------

  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const providers = ctx.orchestrator.getProviderHealths();
      const allHealthy = providers.every((p) => p.healthy);

      const body = healthResponseSchema.parse({
        status: allHealthy ? 'ok' : 'degraded',
        uptime: process.uptime(),
        timestamp: Date.now(),
      });
      res.json(body);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

function handleRouteError(res: Response, err: unknown): void {
  if (err instanceof ZodError) {
    errorJson(res, 400, err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '));
    return;
  }

  // Handle ServiceUnavailableError with explicit 503 status
  if (err instanceof ServiceUnavailableError) {
    errorJson(res, 503, err.message);
    return;
  }

  const message = err instanceof Error ? err.message : 'Unknown error';

  if (message.includes('CIRCUIT_OPEN')) {
    errorJson(res, 503, message);
    return;
  }
  if (message.includes('RATE_LIMITED')) {
    errorJson(res, 429, message);
    return;
  }

  log.error({ err }, 'Unhandled route error');
  errorJson(res, 500, message);
}
