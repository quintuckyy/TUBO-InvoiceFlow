import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';

const server = createApp().listen(config.port, () => {
  logger.info('Tubo API listening', { port: config.port, env: config.env });
});

// Graceful shutdown: stop accepting new connections, finish in-flight requests, then close the pool.
function shutdown(signal) {
  logger.info('Shutting down API', { signal });
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
