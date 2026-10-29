// Integration tests against the real Postgres database (docker compose up -d && npm run migrate).
// Each run creates its own throwaway companies so it doesn't touch seed data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { pool } from '../src/db/pool.js';
import { ConflictError, NotFoundError } from '../src/lib/errors.js';
import { createInvoice, getInvoice, retryInvoice } from '../src/services/invoice.service.js';
import { createInvoiceSchema } from '../src/validation/invoice.schema.js';

const tenants = {};

async function createTenant(label) {
  const suffix = randomUUID().slice(0, 8);
  const { rows: [company] } = await pool.query(
    'INSERT INTO companies (name, tax_id) VALUES ($1, $2) RETURNING id',
    [`Test ${label} ${suffix}`, `TEST-${label}-${suffix}`],
  );
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (company_id, email, password_hash, full_name) VALUES ($1, $2, 'x', $3) RETURNING id`,
    [company.id, `${label}-${suffix}@test.local`, label],
  );
  return { companyId: company.id, userId: user.id };
}

const sampleInput = (invoiceNumber) =>
  createInvoiceSchema.parse({
    invoiceNumber,
    invoiceDate: '2026-01-15',
    customerName: 'Customer',
    customerTaxId: 'CUST-1',
    customerEmail: 'c@test.local',
    currency: 'usd',
    items: [{ description: 'Item', quantity: '1', unitPrice: '100.00', taxRate: '10' }],
  });

before(async () => {
  tenants.a = await createTenant('A');
  tenants.b = await createTenant('B');
});

after(async () => {
  const ids = [tenants.a.companyId, tenants.b.companyId];
  await pool.query('DELETE FROM invoice_processing_attempts WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = ANY($1))', [ids]);
  await pool.query('DELETE FROM invoices WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM users WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
  await pool.end();
});

test('Part J / C3: 10 simultaneous identical requests create exactly one invoice', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => createInvoice({ ...tenants.a, input: sampleInput('INV-10001') })),
  );

  const created = results.filter((r) => r.status === 'fulfilled');
  const conflicts = results.filter((r) => r.status === 'rejected' && r.reason instanceof ConflictError);
  assert.equal(created.length, 1);
  assert.equal(conflicts.length, 9);
  assert.equal(conflicts[0].reason.details.existingInvoiceId, created[0].value.id);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM invoices WHERE company_id = $1 AND invoice_number = $2', [
    tenants.a.companyId,
    'INV-10001',
  ]);
  assert.equal(rows[0].n, 1);
});

test('the same invoice number is allowed for a different company', async () => {
  const invoice = await createInvoice({ ...tenants.b, input: sampleInput('INV-10001') });
  assert.equal(invoice.status, 'PENDING');
});

test('server calculates totals and stores items', async () => {
  const invoice = await createInvoice({ ...tenants.a, input: sampleInput('INV-TOTALS') });
  assert.equal(invoice.subtotal, '100.00');
  assert.equal(invoice.taxAmount, '10.00');
  assert.equal(invoice.totalAmount, '110.00');
  assert.equal(invoice.currency, 'USD');
  assert.equal(invoice.items.length, 1);
});

test('Part E1: a user cannot read another company\'s invoice by id', async () => {
  const invoiceOfB = await createInvoice({ ...tenants.b, input: sampleInput('INV-SECRET') });
  await assert.rejects(getInvoice({ companyId: tenants.a.companyId, invoiceId: invoiceOfB.id }), NotFoundError);
  await assert.rejects(retryInvoice({ companyId: tenants.a.companyId, invoiceId: invoiceOfB.id }), NotFoundError);
});

test('only FAILED invoices can be retried, and only once concurrently', async () => {
  const invoice = await createInvoice({ ...tenants.a, input: sampleInput('INV-RETRY') });
  await assert.rejects(retryInvoice({ companyId: tenants.a.companyId, invoiceId: invoice.id }), ConflictError);

  await pool.query(`UPDATE invoices SET status = 'FAILED' WHERE id = $1`, [invoice.id]);
  const results = await Promise.allSettled([
    retryInvoice({ companyId: tenants.a.companyId, invoiceId: invoice.id }),
    retryInvoice({ companyId: tenants.a.companyId, invoiceId: invoice.id }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});
