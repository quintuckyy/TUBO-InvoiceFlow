// Mock of the external government invoicing API (Part G). It is a separate process on purpose,
// so it behaves like a real remote dependency: it can be slow, down, reject, or time out.
//
// Behaviour:
//  - Requires "Authorization: Bearer <GOV_API_KEY>" and an "Idempotency-Key" header.
//  - Same key seen before and accepted -> returns the ORIGINAL receipt (no duplicate registration).
//  - Same key with a different payload -> 422 (key misuse).
//  - Otherwise randomly: 503 unavailable, 400 rejected, timeout, or 200 success (rates from env).
//  - Deterministic triggers via customer name, for demos:
//      "[reject]"  -> always 400
//      "[timeout]" -> first call accepts the invoice but responds too late (the Part I scenario)
//  - POST /government-api/_admin/outage {"enabled": true|false} simulates a long outage (Part H3).
//
// State is in memory. A real government system persists it, which is what makes idempotency work.
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';

const port = Number(process.env.MOCK_GOV_PORT ?? 4001);
const apiKey = process.env.GOV_API_KEY;
const rates = {
  unavailable: Number(process.env.MOCK_GOV_UNAVAILABLE_RATE ?? 0.2),
  reject: Number(process.env.MOCK_GOV_REJECT_RATE ?? 0.05),
  timeout: Number(process.env.MOCK_GOV_TIMEOUT_RATE ?? 0.1),
};
const timeoutDelayMs = Number(process.env.MOCK_GOV_TIMEOUT_DELAY_MS ?? 20000);
const maxRps = Number(process.env.MOCK_GOV_MAX_RPS ?? 100);

if (!apiKey) throw new Error('GOV_API_KEY is required');

const receiptsByKey = new Map(); // idempotencyKey -> { payloadHash, receipt }
let outage = false;
let windowStart = Date.now();
let requestsInWindow = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const log = (msg, fields) => console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'mock-gov', msg, ...fields }));

const app = express();
app.use(express.json({ limit: '1mb' }));

app.post('/government-api/_admin/outage', (req, res) => {
  outage = Boolean(req.body?.enabled);
  log('Outage toggled', { outage });
  res.json({ outage });
});

app.get('/government-api/invoices/:key', (req, res) => {
  const stored = receiptsByKey.get(req.params.key);
  if (!stored) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown idempotency key' } });
  res.json(stored.receipt);
});

app.post('/government-api/invoices', async (req, res) => {
  if (req.get('authorization') !== `Bearer ${apiKey}`) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API credentials' } });
  }

  // Simple fixed-window rate limit, like a real provider would enforce.
  if (Date.now() - windowStart >= 1000) {
    windowStart = Date.now();
    requestsInWindow = 0;
  }
  if (++requestsInWindow > maxRps) {
    return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
  }

  const key = req.get('idempotency-key');
  if (!key) return res.status(400).json({ error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required' } });

  const payloadHash = hash(req.body);
  const existing = receiptsByKey.get(key);
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      return res.status(422).json({ error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'Key was used with a different payload' } });
    }
    log('Duplicate submission suppressed', { key, reference: existing.receipt.governmentReference });
    return res.status(200).json({ ...existing.receipt, duplicate: true });
  }

  await sleep(50 + Math.random() * 450); // normal latency

  if (outage) return res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Planned maintenance' } });

  const body = req.body ?? {};
  if (!body.invoiceNumber || !body.seller?.taxId || !Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: { code: 'INVALID_INVOICE', message: 'Missing required invoice fields' } });
  }

  const customerName = String(body.customer?.name ?? '').toLowerCase();
  const roll = Math.random();
  let mode = 'success';
  if (customerName.includes('[reject]')) mode = 'reject';
  else if (customerName.includes('[timeout]')) mode = 'timeout';
  else if (roll < rates.unavailable) mode = 'unavailable';
  else if (roll < rates.unavailable + rates.reject) mode = 'reject';
  else if (roll < rates.unavailable + rates.reject + rates.timeout) mode = 'timeout';

  if (mode === 'unavailable') {
    log('Responding 503', { key });
    return res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable, try again later' } });
  }
  if (mode === 'reject') {
    log('Rejecting invoice', { key });
    return res.status(400).json({ error: { code: 'INVALID_INVOICE', message: 'Customer tax ID failed government validation' } });
  }

  const receipt = {
    governmentReference: `GOV-${randomUUID().slice(0, 8).toUpperCase()}`,
    invoiceNumber: body.invoiceNumber,
    sellerTaxId: body.seller.taxId,
    receivedAt: new Date().toISOString(),
  };
  receiptsByKey.set(key, { payloadHash, receipt });

  if (mode === 'timeout') {
    // The invoice IS registered, but the answer arrives after the client gave up.
    log('Accepted but responding slowly (client will time out)', { key, reference: receipt.governmentReference });
    await sleep(timeoutDelayMs);
  } else {
    log('Accepted invoice', { key, reference: receipt.governmentReference });
  }
  if (!res.headersSent && !res.destroyed) res.status(200).json(receipt);
});

app.listen(port, () => log('Mock government API listening', { port, rates }));
