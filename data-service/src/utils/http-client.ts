import axios, {
  AxiosInstance,
  AxiosError,
  InternalAxiosRequestConfig,
  AxiosResponse,
} from 'axios';
import { createChildLogger } from './logger';

export interface HttpClientConfig {
  baseURL: string;
  timeout?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
  vendor: string;
}

const DEFAULT_TIMEOUT = 6000;
const DEFAULT_MAX_RETRIES = 2;
const BASE_DELAY_MS = 250;

interface RequestMeta {
  startTime: number;
  attempt: number;
}

const REQUEST_META = Symbol('requestMeta');

function attachMeta(config: InternalAxiosRequestConfig, meta: RequestMeta): void {
  (config as any)[REQUEST_META] = meta;
}

function getMeta(config: InternalAxiosRequestConfig): RequestMeta | undefined {
  return (config as any)[REQUEST_META];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHttpClient(config: HttpClientConfig): AxiosInstance {
  const {
    baseURL,
    timeout = DEFAULT_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
    headers = {},
    vendor,
  } = config;

  const log = createChildLogger(`http-client:${vendor}`);

  const client = axios.create({
    baseURL,
    timeout,
    headers,
  });

  client.interceptors.request.use((reqConfig) => {
    attachMeta(reqConfig, { startTime: Date.now(), attempt: 1 });
    log.info({ vendor, method: reqConfig.method?.toUpperCase(), url: reqConfig.url }, 'request_start');
    return reqConfig;
  });

  client.interceptors.response.use(
    (response: AxiosResponse) => {
      const meta = getMeta(response.config);
      const latencyMs = meta ? Date.now() - meta.startTime : -1;
      log.info(
        {
          vendor,
          method: response.config.method?.toUpperCase(),
          url: response.config.url,
          status: response.status,
          latencyMs,
        },
        'request_end',
      );
      return response;
    },
    async (error: AxiosError) => {
      const reqConfig = error.config;
      if (!reqConfig) {
        log.error({ vendor, error: error.message }, 'request_failed_no_config');
        return Promise.reject(error);
      }

      const meta = getMeta(reqConfig) ?? { startTime: Date.now(), attempt: 1 };
      const attempt = meta.attempt;

      const isRetryable =
        !error.response ||
        error.response.status >= 500 ||
        error.code === 'ECONNABORTED' ||
        error.code === 'ETIMEDOUT';

      if (isRetryable && attempt <= maxRetries) {
        const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        log.warn(
          {
            vendor,
            attempt,
            maxRetries,
            delayMs,
            error: error.message,
          },
          'request_retry',
        );

        await sleep(delayMs);

        attachMeta(reqConfig, { startTime: meta.startTime, attempt: attempt + 1 });
        return client.request(reqConfig);
      }

      const latencyMs = Date.now() - meta.startTime;
      log.error(
        {
          vendor,
          method: reqConfig.method?.toUpperCase(),
          url: reqConfig.url,
          status: error.response?.status ?? null,
          latencyMs,
          attempt,
          error: error.message,
        },
        'request_failed',
      );
      return Promise.reject(error);
    },
  );

  return client;
}

export default createHttpClient;
