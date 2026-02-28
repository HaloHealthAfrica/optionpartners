import { z } from 'zod';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

export const symbolParamSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .max(10)
    .transform((s) => s.toUpperCase()),
});

export const chainQuerySchema = z.object({
  exp: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'exp must be YYYY-MM-DD'),
  right: z
    .enum(['CALL', 'PUT'])
    .optional(),
});

export const contractsBodySchema = z.object({
  contracts: z
    .array(z.string().min(1))
    .min(1)
    .max(200),
});

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export const errorResponseSchema = z.object({
  error: z.string(),
  status: z.number(),
  timestamp: z.number(),
});

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const underlyingQuoteResponseSchema = z.object({
  symbol: z.string(),
  price: z.number(),
  change: z.number(),
  changePercent: z.number(),
  volume: z.number(),
  timestamp: z.number(),
  source: z.string(),
});

export const expirationsResponseSchema = z.object({
  symbol: z.string(),
  expirations: z.array(z.string()),
  source: z.string(),
});

export const normalizedOptionContractSchema = z.object({
  canonicalId: z.string(),
  underlying: z.string(),
  expiration: z.string(),
  right: z.enum(['C', 'P']),
  strike: z.number(),
  bid: z.number(),
  ask: z.number(),
  mid: z.number(),
  last: z.number(),
  volume: z.number(),
  openInterest: z.number(),
  iv: z.number(),
  delta: z.number(),
  gamma: z.number(),
  theta: z.number(),
  vega: z.number(),
  updatedAt: z.number(),
  source: z.string(),
});

export const chainResponseSchema = z.object({
  symbol: z.string(),
  expiration: z.string(),
  contracts: z.array(normalizedOptionContractSchema),
  count: z.number(),
  source: z.string(),
});

export const normalizedOptionQuoteSchema = z.object({
  canonicalId: z.string(),
  bid: z.number(),
  ask: z.number(),
  mid: z.number(),
  updatedAt: z.number(),
  source: z.string(),
});

export const optionQuotesResponseSchema = z.object({
  quotes: z.array(normalizedOptionQuoteSchema),
  count: z.number(),
});

export const greeksResultSchema = z.object({
  canonicalId: z.string(),
  iv: z.number(),
  delta: z.number(),
  gamma: z.number(),
  theta: z.number(),
  vega: z.number(),
  updatedAt: z.number(),
  source: z.string(),
});

export const greeksResponseSchema = z.object({
  greeks: z.array(greeksResultSchema),
  count: z.number(),
});

export const sourcesResponseSchema = z.object({
  providers: z.array(z.object({
    name: z.string(),
    healthy: z.boolean(),
    circuitState: z.string(),
    successRate: z.number(),
    avgLatencyMs: z.number(),
  })),
  timestamp: z.number(),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptime: z.number(),
  timestamp: z.number(),
});

// ---------------------------------------------------------------------------
// Historical data schemas
// ---------------------------------------------------------------------------

export const historicalTimeframeEnum = z.enum(['1m', '5m', '15m', '1h', '1d']);

export const historicalCandlesQuerySchema = z.object({
  tf: historicalTimeframeEnum.default('1d'),
  start: z.string().min(1, 'start is required'),
  end: z.string().min(1, 'end is required'),
});

export const historicalCandleSchema = z.object({
  t: z.number(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number().optional(),
  source: z.literal('TWELVEDATA'),
  ts: z.number(),
});

export const historicalCandlesResponseSchema = z.object({
  symbol: z.string(),
  timeframe: historicalTimeframeEnum,
  start: z.string(),
  end: z.string(),
  candles: z.array(historicalCandleSchema),
  count: z.number(),
  chunks: z.number(),
  cached: z.boolean(),
  ts: z.number(),
});

export const metricsQuerySchema = z.object({
  tf: historicalTimeframeEnum.default('1d'),
  lookback: z.coerce.number().int().min(20).max(1000).default(252),
});

export const derivedMetricsResponseSchema = z.object({
  symbol: z.string(),
  timeframe: z.string(),
  start: z.string(),
  end: z.string(),
  atr14: z.number(),
  atr30: z.number(),
  hv20: z.number(),
  hv60: z.number(),
  hvPercentile252: z.number(),
  ts: z.number(),
  source: z.literal('DERIVED'),
});

export const regimeResultSchema = z.object({
  symbol: z.string(),
  regime: z.enum(['HIGH_VOL_EXPANSION', 'LOW_VOL_CHOP', 'TRENDING', 'NEUTRAL']),
  metrics: derivedMetricsResponseSchema,
  rulesTriggered: z.array(z.string()),
  ts: z.number(),
});

export const ivStubResponseSchema = z.object({
  status: z.literal('NOT_SUPPORTED'),
  message: z.string(),
  ts: z.number(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type UnderlyingQuoteResponse = z.infer<typeof underlyingQuoteResponseSchema>;
export type ExpirationsResponse = z.infer<typeof expirationsResponseSchema>;
export type ChainResponse = z.infer<typeof chainResponseSchema>;
export type OptionQuotesResponse = z.infer<typeof optionQuotesResponseSchema>;
export type GreeksResult = z.infer<typeof greeksResultSchema>;
export type GreeksResponse = z.infer<typeof greeksResponseSchema>;
export type SourcesResponse = z.infer<typeof sourcesResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type HistoricalCandle = z.infer<typeof historicalCandleSchema>;
export type HistoricalCandlesResponse = z.infer<typeof historicalCandlesResponseSchema>;
export type DerivedMetricsResponse = z.infer<typeof derivedMetricsResponseSchema>;
export type RegimeResult = z.infer<typeof regimeResultSchema>;
