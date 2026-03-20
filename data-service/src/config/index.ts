import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  port: z.coerce.number().default(4000),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  apiKey: z.string().min(1),

  twelveData: z.object({
    apiKey: z.string().default(''),
    baseUrl: z.string().default('https://api.twelvedata.com'),
    rateLimit: z.coerce.number().default(610),
  }),

  unusualWhales: z.object({
    apiKey: z.string().default(''),
    baseUrl: z.string().default('https://api.unusualwhales.com'),
    rateLimit: z.coerce.number().default(120),
  }),

  marketData: z.object({
    apiToken: z.string().default(''),
    baseUrl: z.string().default('https://api.marketdata.app'),
    rateLimit: z.coerce.number().default(100),
  }),

  polygon: z.object({
    apiKey: z.string().default(''),
    baseUrl: z.string().default('https://api.polygon.io'),
    rateLimit: z.coerce.number().default(100),
  }),

  cboe: z.object({
    baseUrl: z.string().default('https://cdn.cboe.com'),
    rateLimit: z.coerce.number().default(10),
  }),

  fred: z.object({
    apiKey: z.string().default(''),
    baseUrl: z.string().default('https://api.stlouisfed.org'),
  }),

  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
  }),

  database: z.object({
    url: z.string().default('postgresql://localhost:5432/data_service'),
  }),

  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  cache: z.object({
    // optional TTL overrides per data type (seconds)
    ttl: z.record(z.string(), z.coerce.number()).optional(),
  }).optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

function loadConfig(): AppConfig {
  const raw = {
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    apiKey: process.env.API_KEY || 'dev-key',

    twelveData: {
      apiKey: process.env.TWELVE_DATA_API_KEY || '',
      baseUrl: process.env.TWELVE_DATA_BASE_URL,
      rateLimit: process.env.TWELVE_DATA_RATE_LIMIT,
    },

    unusualWhales: {
      apiKey: process.env.UNUSUAL_WHALES_API_KEY || '',
      baseUrl: process.env.UNUSUAL_WHALES_BASE_URL,
      rateLimit: process.env.UNUSUAL_WHALES_RATE_LIMIT,
    },

    marketData: {
      apiToken: process.env.MARKETDATA_API_TOKEN || '',
      baseUrl: process.env.MARKETDATA_BASE_URL,
      rateLimit: process.env.MARKETDATA_RATE_LIMIT,
    },

    polygon: {
      apiKey: process.env.POLYGON_API_KEY,
      baseUrl: process.env.POLYGON_BASE_URL,
      rateLimit: process.env.POLYGON_RATE_LIMIT,
    },

    cboe: {
      baseUrl: process.env.CBOE_BASE_URL,
      rateLimit: process.env.CBOE_RATE_LIMIT,
    },

    fred: {
      apiKey: process.env.FRED_API_KEY,
      baseUrl: process.env.FRED_BASE_URL,
    },

    redis: {
      url: process.env.REDIS_URL,
    },

    database: {
      url: process.env.DATABASE_URL,
    },

    logLevel: process.env.LOG_LEVEL,
  };

  return configSchema.parse(raw);
}

export const config = loadConfig();

/**
 * Validates provider API key configuration at startup
 * Returns summary of which API keys are present/missing
 */
export function validateProviderConfiguration(): {
  isValid: boolean;
  summary: {
    twelveData: boolean;
    unusualWhales: boolean;
    polygon: boolean;
    fred: boolean;
  };
  configuredCount: number;
  message: string;
} {
  const summary = {
    twelveData: !!config.twelveData.apiKey && config.twelveData.apiKey.length > 0,
    unusualWhales: !!config.unusualWhales.apiKey && config.unusualWhales.apiKey.length > 0,
    polygon: !!config.polygon.apiKey && config.polygon.apiKey.length > 0,
    fred: !!config.fred.apiKey && config.fred.apiKey.length > 0,
  };

  const configuredCount = Object.values(summary).filter(Boolean).length;
  const isValid = configuredCount > 0;

  const presentKeys = Object.entries(summary)
    .filter(([_, present]) => present)
    .map(([key]) => key);
  
  const missingKeys = Object.entries(summary)
    .filter(([_, present]) => !present)
    .map(([key]) => key);

  let message = '';
  if (configuredCount === 0) {
    message = 'CRITICAL: No provider API keys configured. Service will not be able to fetch real market data. Please configure at least one of: TWELVE_DATA_API_KEY, UNUSUAL_WHALES_API_KEY, POLYGON_API_KEY';
  } else {
    message = `Configuration valid: ${configuredCount} provider API key(s) configured (${presentKeys.join(', ')})`;
    if (missingKeys.length > 0) {
      message += `. Missing: ${missingKeys.join(', ')}`;
    }
  }

  return {
    isValid,
    summary,
    configuredCount,
    message,
  };
}
