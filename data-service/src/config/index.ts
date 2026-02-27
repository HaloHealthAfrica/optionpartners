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
    rateLimit: z.coerce.number().default(800),
  }),

  unusualWhales: z.object({
    apiKey: z.string().default(''),
    baseUrl: z.string().default('https://api.unusualwhales.com'),
    rateLimit: z.coerce.number().default(120),
  }),

  polygon: z.object({
    apiKey: z.string().default(''),
    baseUrl: z.string().default('https://api.polygon.io'),
    rateLimit: z.coerce.number().default(5),
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
