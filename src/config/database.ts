import pg from 'pg';
import { config } from './env.js';

const { Pool } = pg;

export const pool: pg.Pool = new Pool({
  connectionString: config.database.url,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err: Error) => {
  console.error('Unexpected database error:', err);
});

export async function query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
  const start: number = Date.now();
  const result: pg.QueryResult = await pool.query(text, params);
  const duration: number = Date.now() - start;

  if (config.isDev) {
    console.log('Query executed', { text: text.substring(0, 50), duration, rows: result.rowCount });
  }

  return result;
}

export async function getClient(): Promise<pg.PoolClient> {
  const client: pg.PoolClient = await pool.connect();
  return client;
}

export async function testConnection(): Promise<boolean> {
  try {
    const result: pg.QueryResult = await query('SELECT NOW()');
    console.log('Database connected:', result.rows[0].now);
    return true;
  } catch (err: unknown) {
    console.error('Database connection failed:', (err as Error).message);
    return false;
  }
}
