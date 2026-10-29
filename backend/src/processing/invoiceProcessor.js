import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { submitToGovernment } from './governmentClient.js';
import { decideNextStep } from './retryPolicy.js';

/**
 * Atomically claims up to `limit` invoices that are due for processing.
 *
 * FOR UPDATE SKIP LOCKED: if worker 1 has locked a row, worker 2 skips it and takes the next
 * one, so many workers can poll the same table without ever picking the same invoice.
 *
 * Instead of holding a DB lock during the slow HTTP call, the claim sets a LEASE
 * (locked_by + locked_until). If the worker crashes, the lease expires and the second WHERE
 * branch lets another worker reclaim the invoice. Nothing gets stuck in PROCESSING forever.
 */
export async function claimDueInvoices(workerId, limit) {
  const { rows } = await pool.query(
    `WITH due AS (
       SELECT id FROM invoices
        WHERE (status IN ('PENDING', 'RETRYING') AND next_attempt_at <= now())
           OR (status = 'PROCESSING' AND locked_until < now())
        ORDER BY next_attempt_at NULLS FIRST
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE invoices i
        SET status = 'PROCESSING',
            locked_by = $2,
            locked_until = now() + make_interval(secs => $3),
            attempt_count = i.attempt_count + 1,
            attempts_in_cycle = i.attempts_in_cycle + 1
       FROM due
      WHERE i.id = due.id
     RETURNING i.*`,
    [limit, workerId, config.worker.leaseSeconds],
  );
  return rows;
}

/**
 * One submission attempt for a claimed invoice. Every attempt gets its own row in
 * invoice_processing_attempts (inserted BEFORE the call, completed AFTER), so even a crash
 * mid-call leaves a trace.
 */
export async function processInvoice(invoice, { workerId, rateLimiter, log }) {
  const attemptNumber = invoice.attempt_count;

  // If a previous worker died mid-attempt, its attempt row is still IN_PROGRESS. Close it.
  await pool.query(
    `UPDATE invoice_processing_attempts
        SET outcome = 'ABANDONED', finished_at = now(),
            error_message = 'Worker stopped before the attempt finished (lease expired)'
      WHERE invoice_id = $1 AND outcome = 'IN_PROGRESS'`,
    [invoice.id],
  );

  const payload = await buildGovernmentPayload(invoice);
  await rateLimiter.acquire();

  const { rows } = await pool.query(
    `INSERT INTO invoice_processing_attempts (invoice_id, attempt_number, worker_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [invoice.id, attemptNumber, workerId],
  );
  const attemptId = rows[0].id;

  log.info('Submitting invoice', { invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, attemptNumber });
  const result = await submitToGovernment(payload, invoice.id);

  if (result.outcome === 'SUCCESS' && Math.random() < config.worker.chaosCrashAfterSubmitRate) {
    // Part I demo: the government has the invoice, but we die before recording it.
    log.error('CHAOS: crashing after successful submission, before saving SUBMITTED', { invoiceId: invoice.id });
    process.exit(1);
  }

  const next = decideNextStep(result.outcome, invoice.attempts_in_cycle, {
    maxAutoAttempts: config.worker.maxAutoAttempts,
    baseMs: config.worker.backoffBaseMs,
    maxMs: config.worker.backoffMaxMs,
  });

  // Attempt log + invoice status change commit together.
  const updated = await withTransaction(async (client) => {
    await client.query(
      `UPDATE invoice_processing_attempts
          SET finished_at = now(),
              duration_ms = (EXTRACT(EPOCH FROM (clock_timestamp() - started_at)) * 1000)::int,
              outcome = $2, http_status = $3, error_message = $4, response_body = $5
        WHERE id = $1`,
      [attemptId, result.outcome, result.httpStatus, result.error, result.body ? JSON.stringify(result.body) : null],
    );

    // "AND locked_by = $workerId" is a fencing check: if our lease expired and another worker
    // took over, we must not overwrite its result with ours.
    const res = await client.query(
      `UPDATE invoices
          SET status = $3,
              next_attempt_at = $4,
              last_error = $5,
              government_reference = COALESCE($6, government_reference),
              submitted_at = CASE WHEN $3 = 'SUBMITTED' THEN now() ELSE submitted_at END,
              locked_by = NULL,
              locked_until = NULL
        WHERE id = $1 AND locked_by = $2 AND status = 'PROCESSING'`,
      [
        invoice.id,
        workerId,
        next.status,
        next.nextAttemptAt,
        result.outcome === 'SUCCESS' ? null : result.error,
        result.body?.governmentReference ?? null,
      ],
    );
    return res.rowCount === 1;
  });

  const logFields = { invoiceId: invoice.id, attemptNumber, outcome: result.outcome, httpStatus: result.httpStatus };
  if (!updated) log.warn('Lease lost before saving result; another worker owns this invoice now', logFields);
  else if (next.status === 'SUBMITTED') log.info('Invoice submitted', { ...logFields, duplicate: !!result.body?.duplicate });
  else log.warn('Invoice attempt failed', { ...logFields, newStatus: next.status, nextAttemptAt: next.nextAttemptAt, error: result.error });
}

async function buildGovernmentPayload(invoice) {
  const [company, items] = await Promise.all([
    pool.query('SELECT name, tax_id FROM companies WHERE id = $1', [invoice.company_id]),
    pool.query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY line_number', [invoice.id]),
  ]);

  return {
    invoiceNumber: invoice.invoice_number,
    invoiceDate: invoice.invoice_date,
    seller: { name: company.rows[0].name, taxId: company.rows[0].tax_id },
    customer: { name: invoice.customer_name, taxId: invoice.customer_tax_id, email: invoice.customer_email },
    currency: invoice.currency,
    subtotal: invoice.subtotal,
    taxAmount: invoice.tax_amount,
    totalAmount: invoice.total_amount,
    items: items.rows.map((item) => ({
      lineNumber: item.line_number,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      taxRate: item.tax_rate,
      lineTotal: item.line_total,
    })),
  };
}
