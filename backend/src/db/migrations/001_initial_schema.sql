-- Tubo initial schema.
-- Money is stored as NUMERIC (exact decimal), never FLOAT.
-- Statuses are TEXT + CHECK constraints: as strict as an enum, but easier to evolve in later migrations.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Companies (tenants). Every business record hangs off a company.
-- ---------------------------------------------------------------------------
CREATE TABLE companies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  tax_id      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT companies_tax_id_uq UNIQUE (tax_id)
);
CREATE TRIGGER companies_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Users. Each user belongs to exactly one company.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness: "A@x.com" and "a@x.com" are the same login.
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));
CREATE INDEX users_company_id_idx ON users (company_id);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Invoices. The row doubles as the processing job ("transactional outbox"):
-- inserting the invoice in status PENDING *is* enqueuing it, in the same
-- transaction, so an accepted invoice can never be lost between "saved" and "queued".
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  invoice_number        TEXT NOT NULL,
  invoice_date          DATE NOT NULL,
  customer_name         TEXT NOT NULL,
  customer_tax_id       TEXT NOT NULL,
  customer_email        TEXT NOT NULL,
  currency              CHAR(3) NOT NULL,
  subtotal              NUMERIC(14,2) NOT NULL,
  tax_amount            NUMERIC(14,2) NOT NULL,
  total_amount          NUMERIC(14,2) NOT NULL,

  status                TEXT NOT NULL DEFAULT 'PENDING',

  -- Processing / queue bookkeeping
  attempt_count         INT NOT NULL DEFAULT 0,      -- all attempts ever (used as attempt_number)
  attempts_in_cycle     INT NOT NULL DEFAULT 0,      -- attempts since creation or last manual retry
  next_attempt_at       TIMESTAMPTZ DEFAULT now(),   -- when a worker may pick it up
  locked_by             TEXT,                        -- worker that holds the lease
  locked_until          TIMESTAMPTZ,                 -- lease expiry; lets another worker recover a crashed one
  last_error            TEXT,
  government_reference  TEXT,
  submitted_at          TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The duplicate guard: one invoice number per company, enforced by the database.
  CONSTRAINT invoices_company_number_uq UNIQUE (company_id, invoice_number),
  CONSTRAINT invoices_status_chk CHECK (status IN
    ('PENDING', 'PROCESSING', 'RETRYING', 'SUBMITTED', 'FAILED', 'REJECTED')),
  CONSTRAINT invoices_amounts_chk CHECK (subtotal >= 0 AND tax_amount >= 0),
  CONSTRAINT invoices_total_chk CHECK (total_amount = subtotal + tax_amount),
  CONSTRAINT invoices_currency_chk CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Dashboard listing / filtering (always scoped by company first).
CREATE INDEX invoices_company_date_idx   ON invoices (company_id, invoice_date DESC, created_at DESC);
CREATE INDEX invoices_company_status_idx ON invoices (company_id, status);
-- Worker polling: small partial indexes that only contain rows with work to do.
CREATE INDEX invoices_due_work_idx      ON invoices (next_attempt_at) WHERE status IN ('PENDING', 'RETRYING');
CREATE INDEX invoices_expired_lease_idx ON invoices (locked_until)    WHERE status = 'PROCESSING';

-- ---------------------------------------------------------------------------
-- Invoice items
-- ---------------------------------------------------------------------------
CREATE TABLE invoice_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_number    INT NOT NULL,
  description    TEXT NOT NULL,
  quantity       NUMERIC(12,3) NOT NULL,
  unit_price     NUMERIC(14,2) NOT NULL,
  tax_rate       NUMERIC(5,2)  NOT NULL,   -- percent, e.g. 12.00
  line_subtotal  NUMERIC(14,2) NOT NULL,   -- quantity * unit_price
  tax_amount     NUMERIC(14,2) NOT NULL,
  line_total     NUMERIC(14,2) NOT NULL,
  CONSTRAINT invoice_items_line_uq UNIQUE (invoice_id, line_number),
  CONSTRAINT invoice_items_line_number_chk CHECK (line_number > 0),
  CONSTRAINT invoice_items_quantity_chk CHECK (quantity > 0),
  CONSTRAINT invoice_items_unit_price_chk CHECK (unit_price >= 0),
  CONSTRAINT invoice_items_tax_rate_chk CHECK (tax_rate BETWEEN 0 AND 100),
  CONSTRAINT invoice_items_total_chk CHECK (line_total = line_subtotal + tax_amount)
);

-- ---------------------------------------------------------------------------
-- Processing log: one append-only row per submission attempt. Never overwritten,
-- so support can reconstruct the full history of any invoice.
-- RESTRICT (not CASCADE): audit history must not disappear silently.
-- ---------------------------------------------------------------------------
CREATE TABLE invoice_processing_attempts (
  id              BIGSERIAL PRIMARY KEY,
  invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  attempt_number  INT NOT NULL,
  worker_id       TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  duration_ms     INT,
  outcome         TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  http_status     INT,
  error_message   TEXT,
  response_body   JSONB,
  CONSTRAINT attempts_invoice_attempt_uq UNIQUE (invoice_id, attempt_number),
  CONSTRAINT attempts_outcome_chk CHECK (outcome IN
    ('IN_PROGRESS', 'SUCCESS', 'REJECTED', 'RETRYABLE_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'ERROR', 'ABANDONED'))
);
-- Operational queries like "all failures in the last 3 days".
CREATE INDEX attempts_started_at_idx ON invoice_processing_attempts (started_at);
