import { getPool } from './db';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger('migrations');

const MIGRATIONS = [
  {
    name: '001_create_gex_snapshots',
    sql: `
      CREATE TABLE IF NOT EXISTS gex_snapshots (
        id            SERIAL PRIMARY KEY,
        symbol        VARCHAR(10) NOT NULL,
        total_gex     DOUBLE PRECISION NOT NULL,
        call_gex      DOUBLE PRECISION NOT NULL,
        put_gex       DOUBLE PRECISION NOT NULL,
        net_gex       DOUBLE PRECISION NOT NULL,
        flip_price    DOUBLE PRECISION,
        major_levels  JSONB NOT NULL DEFAULT '[]',
        provider      VARCHAR(30) NOT NULL DEFAULT 'unusual_whales',
        captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_gex_symbol_time UNIQUE (symbol, captured_at)
      );
      CREATE INDEX IF NOT EXISTS idx_gex_symbol ON gex_snapshots (symbol);
      CREATE INDEX IF NOT EXISTS idx_gex_captured_at ON gex_snapshots (captured_at);
    `,
  },
  {
    name: '002_create_flow_snapshots',
    sql: `
      CREATE TABLE IF NOT EXISTS options_flow_snapshots (
        id              SERIAL PRIMARY KEY,
        symbol          VARCHAR(10) NOT NULL,
        total_premium   DOUBLE PRECISION NOT NULL,
        call_premium    DOUBLE PRECISION NOT NULL,
        put_premium     DOUBLE PRECISION NOT NULL,
        net_premium     DOUBLE PRECISION NOT NULL,
        call_volume     INTEGER NOT NULL DEFAULT 0,
        put_volume      INTEGER NOT NULL DEFAULT 0,
        put_call_ratio  DOUBLE PRECISION NOT NULL DEFAULT 0,
        sentiment       VARCHAR(10) NOT NULL DEFAULT 'neutral',
        largest_trades  JSONB NOT NULL DEFAULT '[]',
        provider        VARCHAR(30) NOT NULL DEFAULT 'unusual_whales',
        captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_flow_symbol_time UNIQUE (symbol, captured_at)
      );
      CREATE INDEX IF NOT EXISTS idx_flow_symbol ON options_flow_snapshots (symbol);
      CREATE INDEX IF NOT EXISTS idx_flow_captured_at ON options_flow_snapshots (captured_at);
    `,
  },
  {
    name: '003_create_candle_history',
    sql: `
      CREATE TABLE IF NOT EXISTS candle_history (
        id          SERIAL PRIMARY KEY,
        symbol      VARCHAR(10) NOT NULL,
        timeframe   VARCHAR(10) NOT NULL,
        timestamp   BIGINT NOT NULL,
        open        DOUBLE PRECISION NOT NULL,
        high        DOUBLE PRECISION NOT NULL,
        low         DOUBLE PRECISION NOT NULL,
        close       DOUBLE PRECISION NOT NULL,
        volume      BIGINT NOT NULL DEFAULT 0,
        provider    VARCHAR(30) NOT NULL DEFAULT 'twelvedata',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_candle_sym_tf_ts UNIQUE (symbol, timeframe, timestamp)
      );
      CREATE INDEX IF NOT EXISTS idx_candle_symbol_tf ON candle_history (symbol, timeframe);
      CREATE INDEX IF NOT EXISTS idx_candle_timestamp ON candle_history (timestamp);
    `,
  },
  {
    name: '004_create_vix_snapshots',
    sql: `
      CREATE TABLE IF NOT EXISTS vix_snapshots (
        id              SERIAL PRIMARY KEY,
        spot            DOUBLE PRECISION NOT NULL,
        futures         JSONB NOT NULL DEFAULT '[]',
        term_structure  VARCHAR(20) NOT NULL DEFAULT 'flat',
        captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_vix_captured_at ON vix_snapshots (captured_at);
    `,
  },
  {
    name: '005_create_macro_snapshots',
    sql: `
      CREATE TABLE IF NOT EXISTS macro_snapshots (
        id              SERIAL PRIMARY KEY,
        fed_funds_rate  DOUBLE PRECISION,
        yield_2y        DOUBLE PRECISION,
        yield_10y       DOUBLE PRECISION,
        yield_spread    DOUBLE PRECISION,
        next_fomc       VARCHAR(30),
        data            JSONB NOT NULL DEFAULT '{}',
        captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_macro_captured_at ON macro_snapshots (captured_at);
    `,
  },
  {
    name: '006_create_migrations_table',
    sql: `
      CREATE TABLE IF NOT EXISTS data_service_migrations (
        name        VARCHAR(100) PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    name: '007_create_volatility_snapshots',
    sql: `
      CREATE TABLE IF NOT EXISTS volatility_snapshots (
        id               SERIAL PRIMARY KEY,
        symbol           VARCHAR(10) NOT NULL,
        regime           VARCHAR(30) NOT NULL,
        metrics          JSONB NOT NULL DEFAULT '{}',
        rules_triggered  JSONB NOT NULL DEFAULT '[]',
        captured_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_vol_snap_symbol ON volatility_snapshots (symbol);
      CREATE INDEX IF NOT EXISTS idx_vol_snap_captured_at ON volatility_snapshots (captured_at);
      CREATE INDEX IF NOT EXISTS idx_vol_snap_symbol_time ON volatility_snapshots (symbol, captured_at DESC);
    `,
  },
  {
    name: '008_add_volatility_snapshot_versioning',
    sql: `
      ALTER TABLE volatility_snapshots
        ADD COLUMN IF NOT EXISTS analytics_version TEXT NOT NULL DEFAULT 'v1',
        ADD COLUMN IF NOT EXISTS timeframe TEXT NOT NULL DEFAULT '1d',
        ADD COLUMN IF NOT EXISTS lookback INTEGER NOT NULL DEFAULT 252;

      UPDATE volatility_snapshots
        SET analytics_version = 'v1', timeframe = '1d', lookback = 252
        WHERE analytics_version IS NULL OR analytics_version = 'v1';
    `,
  },
  {
    name: '009_create_iv_snapshots',
    sql: `
      CREATE TABLE IF NOT EXISTS iv_snapshots (
        id              SERIAL PRIMARY KEY,
        symbol          VARCHAR(10) NOT NULL,
        current_iv      DOUBLE PRECISION NOT NULL,
        iv_rank         DOUBLE PRECISION NOT NULL,
        iv_percentile   DOUBLE PRECISION NOT NULL,
        hv_30           DOUBLE PRECISION,
        hv_60           DOUBLE PRECISION,
        hv_90           DOUBLE PRECISION,
        provider        VARCHAR(30) NOT NULL DEFAULT 'unusual_whales',
        captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_iv_snap_symbol ON iv_snapshots (symbol);
      CREATE INDEX IF NOT EXISTS idx_iv_snap_captured_at ON iv_snapshots (captured_at);
      CREATE INDEX IF NOT EXISTS idx_iv_snap_symbol_time ON iv_snapshots (symbol, captured_at DESC);
    `,
  },
];

export async function runMigrations(): Promise<void> {
  const pool = getPool();

  // Ensure migrations tracking table exists first
  await pool.query(`
    CREATE TABLE IF NOT EXISTS data_service_migrations (
      name        VARCHAR(100) PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows: applied } = await pool.query('SELECT name FROM data_service_migrations');
  const appliedSet = new Set(applied.map((r: { name: string }) => r.name));

  for (const migration of MIGRATIONS) {
    if (migration.name === '006_create_migrations_table') continue;
    if (appliedSet.has(migration.name)) continue;

    log.info({ migration: migration.name }, 'Applying migration');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query('INSERT INTO data_service_migrations (name) VALUES ($1)', [migration.name]);
      await client.query('COMMIT');
      log.info({ migration: migration.name }, 'Migration applied');
    } catch (err) {
      await client.query('ROLLBACK');
      log.error({ migration: migration.name, error: err instanceof Error ? err.message : err }, 'Migration failed');
      throw err;
    } finally {
      client.release();
    }
  }
}
