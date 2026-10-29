// Seeds two companies with one user each (Part E: Company A / User A, Company B / User B)
// and one invoice for Company B so cross-tenant access can be tested. Safe to run repeatedly.
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';
import { ConflictError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { createInvoice } from '../services/invoice.service.js';
import { createInvoiceSchema } from '../validation/invoice.schema.js';

const DEMO_PASSWORD = 'Password123!';

const tenants = [
  { company: { name: 'ABC Corporation', taxId: 'ABC-TAX-0001' }, user: { email: 'usera@abc.test', fullName: 'User A' } },
  { company: { name: 'Beta Trading Ltd', taxId: 'BETA-TAX-0002' }, user: { email: 'userb@beta.test', fullName: 'User B' } },
];

async function upsertTenant({ company, user }, passwordHash) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO companies (name, tax_id) VALUES ($1, $2)
     ON CONFLICT (tax_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [company.name, company.taxId],
  );
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (company_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [c.id, user.email, passwordHash, user.fullName],
  );
  return { companyId: c.id, userId: u.id };
}

async function seed() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const [, companyB] = await Promise.all(tenants.map((t) => upsertTenant(t, passwordHash)));

  const input = createInvoiceSchema.parse({
    invoiceNumber: 'BETA-0001',
    invoiceDate: new Date().toISOString().slice(0, 10),
    customerName: 'Gamma Retail',
    customerTaxId: 'GAMMA-123',
    customerEmail: 'billing@gamma.test',
    currency: 'USD',
    items: [{ description: 'Consulting', quantity: '2', unitPrice: '150.00', taxRate: '12' }],
  });

  let invoiceId;
  try {
    invoiceId = (await createInvoice({ ...companyB, input })).id;
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
    invoiceId = err.details.existingInvoiceId;
  }

  logger.info('Seed complete', {
    logins: tenants.map((t) => `${t.user.email} / ${DEMO_PASSWORD}`),
    companyBInvoiceId: invoiceId,
    hint: 'Log in as usera@abc.test and GET /api/v1/invoices/<companyBInvoiceId>: expect 404',
  });
}

seed()
  .catch((err) => {
    logger.error('Seed failed', { err: err.message });
    process.exitCode = 1;
  })
  .finally(() => pool.end());
