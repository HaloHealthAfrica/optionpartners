import { Pool, PoolConfig } from 'pg';
import { config } from '../config';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger('database');

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const poolConfig: PoolConfig = {
      connectionString: config.database.url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    };
    pool = new Pool(poolConfig);

    pool.on('error', (err) => {
      log.error({ error: err.message }, 'Unexpected database pool error');
    });
  }
  return pool;
}

export async function initDatabase(): Promise<boolean> {
  try {
    const p = getPool();
    const client = await p.connect();
    await client.query('SELECT 1');
    client.release();
    log.info('Database connection established');
    return true;
  } catch (err) {
    log.warn({ error: err instanceof Error ? err.message : err }, 'Database unavailable — persistence disabled');
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    log.info('Database pool closed');
  }
}
