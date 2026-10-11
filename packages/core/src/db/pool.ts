import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

const ssl = config.database.url.includes('localhost') || config.database.url.includes('127.0.0.1')
  ? false
  : { rejectUnauthorized: false };

export const pool = new Pool({
  connectionString: config.database.url,
  max: 10,
  idleTimeoutMillis: 30000,
  ssl,
});

export async function query(text: string, params?: unknown[]) {
  return pool.query(text, params);
}

export async function getClient() {
  return pool.connect();
}

export async function shutdown() {
  await pool.end();
}
