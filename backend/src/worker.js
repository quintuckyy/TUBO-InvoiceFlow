// Background worker: polls the invoices table for due work and submits it to the government API.
// Run as many copies as needed (horizontal scaling); SKIP LOCKED keeps them from colliding.
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { claimDueInvoices, processInvoice } from './processing/invoiceProcessor.js';
import { createRateLimiter } from './processing/rateLimiter.js';

const workerId = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const log = logger.child({ component: 'worker', workerId });
const rateLimiter = createRateLimiter(config.gov.rateLimitPerSec);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let running = true;

async function runLoop() {
  log.info('Worker started', { batchSize: config.worker.batchSize, rateLimitPerSec: config.gov.rateLimitPerSec });

  while (running) {
    let batch;
    try {
      batch = await claimDueInvoices(workerId, config.worker.batchSize);
    } catch (err) {
      // Database unavailable: nothing is lost (invoices are only in the DB), just wait and retry.
      log.error('Failed to claim invoices; backing off', { err: err.message });
      await sleep(config.worker.pollIntervalMs * 5);
      continue;
    }

    if (batch.length === 0) {
      await sleep(config.worker.pollIntervalMs);
      continue;
    }

    // Process the batch concurrently; the rate limiter caps calls/second to the government API.
    await Promise.all(
      batch.map((invoice) =>
        processInvoice(invoice, { workerId, rateLimiter, log }).catch((err) => {
          // The invoice stays PROCESSING; when the lease expires another loop iteration reclaims it.
          log.error('Unexpected error processing invoice', { invoiceId: invoice.id, err: err.message });
        }),
      ),
    );
  }
}

// Graceful shutdown (e.g. during a deploy): stop claiming new work, let the current batch
// finish, then exit. Anything we can't finish is recovered via lease expiry.
const loopDone = runLoop();
async function shutdown(signal) {
  if (!running) return;
  log.info('Stopping worker after current batch', { signal });
  running = false;
  setTimeout(() => process.exit(1), 30_000).unref();
  await loopDone;
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
