import { pool, withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../lib/errors.js';
import { calculateInvoiceTotals, formatCents, formatScaled } from '../lib/money.js';

const MAX_TOTAL_CENTS = 1_000_000_000_000 * 100 - 1; // fits NUMERIC(14,2)

/**
 * Creates an invoice and its items atomically.
 *
 * Duplicate protection does NOT use "SELECT then INSERT" (two concurrent requests could both
 * see "no row" - see Part J). Instead we INSERT ... ON CONFLICT DO NOTHING against the
 * UNIQUE (company_id, invoice_number) constraint. The database serializes the two inserts on
 * that unique index: exactly one succeeds, the other inserts nothing and gets a 409.
 */
export async function createInvoice({ companyId, userId, input }) {
  // The schema already converted the decimals to scaled integers; name them by their unit.
  const totals = calculateInvoiceTotals(
    input.items.map((item) => ({
      description: item.description,
      quantityMilli: item.quantity,
      unitPriceCents: item.unitPrice,
      taxRateBp: item.taxRate,
    })),
  );
  assertClientTotalsMatch(input, totals);
  if (totals.totalCents > MAX_TOTAL_CENTS) {
    throw new UnprocessableError('TOTAL_TOO_LARGE', 'Invoice total exceeds the supported maximum');
  }

  const invoiceId = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO invoices (company_id, created_by, invoice_number, invoice_date, customer_name,
                             customer_tax_id, customer_email, currency, subtotal, tax_amount, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (company_id, invoice_number) DO NOTHING
       RETURNING id`,
      [
        companyId,
        userId,
        input.invoiceNumber,
        input.invoiceDate,
        input.customerName,
        input.customerTaxId,
        input.customerEmail,
        input.currency,
        formatCents(totals.subtotalCents),
        formatCents(totals.taxCents),
        formatCents(totals.totalCents),
      ],
    );

    if (inserted.rowCount === 0) {
      const existing = await client.query(
        'SELECT id FROM invoices WHERE company_id = $1 AND invoice_number = $2',
        [companyId, input.invoiceNumber],
      );
      throw new ConflictError('DUPLICATE_INVOICE', `Invoice ${input.invoiceNumber} already exists for this company`, {
        existingInvoiceId: existing.rows[0]?.id,
      });
    }

    const id = inserted.rows[0].id;
    await insertItems(client, id, totals.lines);
    // Status defaults to PENDING with next_attempt_at = now(): committing this transaction is
    // what enqueues the invoice for the worker. Saved and queued can't diverge.
    return id;
  });

  return getInvoice({ companyId, invoiceId });
}

async function insertItems(client, invoiceId, lines) {
  const values = [];
  const placeholders = lines.map((line, index) => {
    const base = index * 9;
    values.push(
      invoiceId,
      index + 1,
      line.description,
      formatScaled(line.quantityMilli, 3),
      formatCents(line.unitPriceCents),
      formatScaled(line.taxRateBp, 2),
      formatCents(line.lineSubtotalCents),
      formatCents(line.taxCents),
      formatCents(line.lineTotalCents),
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
  });

  await client.query(
    `INSERT INTO invoice_items (invoice_id, line_number, description, quantity, unit_price, tax_rate,
                                line_subtotal, tax_amount, line_total)
     VALUES ${placeholders.join(', ')}`,
    values,
  );
}

function assertClientTotalsMatch(input, totals) {
  const mismatches = [];
  if (input.subtotal !== undefined && input.subtotal !== totals.subtotalCents) mismatches.push('subtotal');
  if (input.taxAmount !== undefined && input.taxAmount !== totals.taxCents) mismatches.push('taxAmount');
  if (input.totalAmount !== undefined && input.totalAmount !== totals.totalCents) mismatches.push('totalAmount');
  if (mismatches.length) {
    throw new UnprocessableError('TOTALS_MISMATCH', 'Provided totals do not match the invoice items', {
      fields: mismatches,
      expected: {
        subtotal: formatCents(totals.subtotalCents),
        taxAmount: formatCents(totals.taxCents),
        totalAmount: formatCents(totals.totalCents),
      },
    });
  }
}

/** Lists invoices of ONE company with optional filters and pagination. */
export async function listInvoices({ companyId, filters }) {
  const conditions = ['company_id = $1'];
  const params = [companyId];
  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };

  if (filters.status) add('status = ?', filters.status);
  if (filters.dateFrom) add('invoice_date >= ?', filters.dateFrom);
  if (filters.dateTo) add('invoice_date <= ?', filters.dateTo);
  if (filters.invoiceNumber) add(`invoice_number ILIKE ? || '%'`, escapeLike(filters.invoiceNumber));

  const where = conditions.join(' AND ');
  const offset = (filters.page - 1) * filters.pageSize;

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM invoices WHERE ${where}
        ORDER BY invoice_date DESC, created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.pageSize, offset],
    ),
    pool.query(`SELECT count(*)::int AS total FROM invoices WHERE ${where}`, params),
  ]);

  const total = countResult.rows[0].total;
  return {
    data: dataResult.rows.map(toInvoiceDto),
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.ceil(total / filters.pageSize),
    },
  };
}

/**
 * Returns header + seller + items + processing attempts.
 * The WHERE clause includes company_id: an invoice of another company is indistinguishable
 * from one that doesn't exist (404, not 403, so we don't even confirm it exists).
 */
export async function getInvoice({ companyId, invoiceId }) {
  const { rows } = await pool.query(
    `SELECT i.*, c.name AS seller_name, c.tax_id AS seller_tax_id
       FROM invoices i JOIN companies c ON c.id = i.company_id
      WHERE i.id = $1 AND i.company_id = $2`,
    [invoiceId, companyId],
  );
  if (!rows[0]) throw new NotFoundError('Invoice not found');

  const [items, attempts] = await Promise.all([
    pool.query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY line_number', [invoiceId]),
    pool.query('SELECT * FROM invoice_processing_attempts WHERE invoice_id = $1 ORDER BY attempt_number DESC', [
      invoiceId,
    ]),
  ]);

  return {
    ...toInvoiceDto(rows[0]),
    seller: { companyId: rows[0].company_id, name: rows[0].seller_name, taxId: rows[0].seller_tax_id },
    items: items.rows.map(toItemDto),
    attempts: attempts.rows.map(toAttemptDto),
  };
}

/**
 * Manual retry. Only FAILED invoices qualify:
 *  - SUBMITTED is done (retrying could duplicate it),
 *  - PENDING / PROCESSING / RETRYING are already in the pipeline,
 *  - REJECTED means the government said the data is invalid; resending identical data won't help.
 * The status check is inside the UPDATE itself, so two simultaneous retry clicks can't both win.
 */
export async function retryInvoice({ companyId, invoiceId }) {
  const { rowCount } = await pool.query(
    `UPDATE invoices
        SET status = 'PENDING', next_attempt_at = now(), attempts_in_cycle = 0
      WHERE id = $1 AND company_id = $2 AND status = 'FAILED'`,
    [invoiceId, companyId],
  );

  if (rowCount === 0) {
    const current = await getInvoice({ companyId, invoiceId }); // throws 404 if not ours
    throw new ConflictError('INVOICE_NOT_RETRYABLE', `Invoice in status ${current.status} cannot be retried`, {
      status: current.status,
    });
  }
  return getInvoice({ companyId, invoiceId });
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function toInvoiceDto(row) {
  const waiting = row.status === 'PENDING' || row.status === 'RETRYING';
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    customerName: row.customer_name,
    customerTaxId: row.customer_tax_id,
    customerEmail: row.customer_email,
    currency: row.currency,
    subtotal: row.subtotal,
    taxAmount: row.tax_amount,
    totalAmount: row.total_amount,
    status: row.status,
    canRetry: row.status === 'FAILED',
    processing: {
      attemptCount: row.attempt_count,
      nextAttemptAt: waiting ? row.next_attempt_at : null,
      lastError: row.last_error,
      governmentReference: row.government_reference,
      submittedAt: row.submitted_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItemDto(row) {
  return {
    lineNumber: row.line_number,
    description: row.description,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    taxRate: row.tax_rate,
    lineSubtotal: row.line_subtotal,
    taxAmount: row.tax_amount,
    lineTotal: row.line_total,
  };
}

function toAttemptDto(row) {
  return {
    attemptNumber: row.attempt_number,
    workerId: row.worker_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    outcome: row.outcome,
    httpStatus: row.http_status,
    errorMessage: row.error_message,
  };
}
