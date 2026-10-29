import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings. The default converts them to a JS Date
// at local midnight, which can shift the day depending on the server's timezone.
pg.types.setTypeParser(1082, (value) => value);
// NUMERIC stays a string (pg's default) on purpose: it is exact, and the API returns money as strings.

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
});

pool.on('error', (err) => logger.error('Unexpected error on idle database client', { err: err.message }));

/**
 * Runs fn(client) inside BEGIN/COMMIT. Any thrown error rolls the whole transaction back,
 * so partial writes (e.g. an invoice without its items) can never be committed.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
