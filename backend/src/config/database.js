const { Pool } = require('pg');
require('dotenv').config();

const poolSize = parseInt(process.env.DB_POOL_SIZE || '50', 10);
const connectionTimeout = parseInt(process.env.DB_CONNECTION_TIMEOUT || '5000', 10);

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      max: poolSize,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: connectionTimeout,
      statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10),
      ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
    }
  : {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: poolSize,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: connectionTimeout,
      statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10),
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Database pool error:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  connect: () => pool.connect(),
  pool
};