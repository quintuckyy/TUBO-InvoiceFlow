# Written Answers

Each answer points to the code that implements it, where there is code.

---

## Part C – Database design

Schema: [001_initial_schema.sql](../backend/src/db/migrations/001_initial_schema.sql)

```
companies 1──* users
companies 1──* invoices 1──* invoice_items
                invoices 1──* invoice_processing_attempts
```

| Table | Key decisions |
|---|---|
| `companies` | Tenant. `UNIQUE(tax_id)`. |
| `users` | FK `company_id`. Unique index on `lower(email)` (case-insensitive login). Only a bcrypt hash is stored. |
| `invoices` | FK `company_id`, `created_by`. **`UNIQUE(company_id, invoice_number)`**. Money `NUMERIC(14,2)`. Status `TEXT + CHECK`. Queue fields (`next_attempt_at`, `locked_by`, `locked_until`, `attempt_count`, `attempts_in_cycle`). `government_reference`, `submitted_at`, `last_error`. |
| `invoice_items` | FK `invoice_id` (CASCADE: items are part of the invoice). `UNIQUE(invoice_id, line_number)`. CHECKs: quantity > 0, price ≥ 0, tax 0–100, `line_total = line_subtotal + tax_amount`. |
| `invoice_processing_attempts` | Append-only log. `UNIQUE(invoice_id, attempt_number)`. Start/end/duration, outcome, HTTP status, error, raw response (`JSONB`). FK is `RESTRICT` so history can't be deleted by accident. |

### C1. Why this design?
- **Relational and normalised.** An invoice has many items and many attempts, so they are child tables, not JSON blobs. That way they can be constrained, indexed and queried ("all 503s yesterday").
- **The database enforces the rules.** Uniqueness, valid statuses, non-negative amounts and `total = subtotal + tax` are constraints. Application code can have bugs, and constraints still hold if a second service or a manual SQL fix writes to the table.
- **Exact money types.** `NUMERIC` in the database and integer cents in JavaScript ([money.js](../backend/src/lib/money.js)). Floats can't represent 0.10 exactly.
- **UUID primary keys.** They can be generated anywhere, aren't guessable or enumerable in URLs, and don't reveal how many invoices a company has.
- **Status as TEXT + CHECK** instead of a Postgres ENUM. Equally strict, but adding a status later is a simple constraint change.
- **The invoice row doubles as the queue entry** (transactional outbox). The invoice and its "job" are written in one transaction, so it is impossible to save an invoice and fail to queue it, or the reverse. That is the main "don't lose invoices" guarantee.
- **Indexes match the queries.** `(company_id, invoice_date)` and `(company_id, status)` for the dashboard (tenant first, because every query filters by it). Small partial indexes `WHERE status IN ('PENDING','RETRYING')` and `WHERE status = 'PROCESSING'` for worker polling. They only contain rows with work, so they stay tiny even with millions of submitted invoices.
- **Separate attempt log.** The status on the invoice is the current state; the attempts table is the history (Part L).

### C2. How does the database prevent the same company creating the same invoice twice?
`CONSTRAINT invoices_company_number_uq UNIQUE (company_id, invoice_number)`. No matter what the application does, Postgres will not store a second row with the same pair. The API uses `INSERT ... ON CONFLICT (company_id, invoice_number) DO NOTHING RETURNING id`. If nothing is returned, it was a duplicate and we answer `409 DUPLICATE_INVOICE` with the existing invoice's id ([invoice.service.js](../backend/src/services/invoice.service.js)). Different companies may reuse the same number.

### C3. Two identical requests at exactly the same time?
Both run `INSERT ... ON CONFLICT DO NOTHING`. The unique index serialises them: the first insert takes the index entry, and the second **waits** for the first transaction. When the first commits, the second sees the conflict and inserts nothing, so it gets 409. If the first rolled back instead, the second would succeed. Either way there is exactly one invoice. This is proven by the test *"10 simultaneous identical requests create exactly one invoice"* in [invoice.integration.test.js](../backend/test/invoice.integration.test.js).

---

## Part E – Authentication & security

### E1
How do we guarantee User A cannot read Company B's invoice by changing the id in the URL?
1. The `companyId` comes **only from the signed JWT** ([auth.js](../backend/src/middleware/auth.js)). The client cannot change it without invalidating the signature.
2. **Every query is scoped:** `WHERE i.id = $1 AND i.company_id = $2`. For User A, Company B's invoice simply doesn't exist, so the answer is **404** (not 403, which would confirm the id exists). The same applies to list and retry.
3. Request bodies are `.strict()`: sending `companyId` is a 400, so there's no mass-assignment trick.
4. UUID ids can't be guessed by incrementing.
5. Covered by a test. In production I'd add Postgres **Row-Level Security** as a second line of defence in case a future query forgets the filter.

### E2. Where to store secrets
| Secret | Where |
|---|---|
| Database password | Environment variable injected at runtime. In production it comes from a secret manager (AWS Secrets Manager, GCP Secret Manager, Vault, Kubernetes Secrets), ideally short-lived/IAM-based credentials |
| JWT secret | Same: secret manager → env var. Long random value, rotated (or asymmetric RS256/ES256 keys in a KMS) |
| Government API credentials | Same: secret manager, only given to the worker (least privilege; the API process doesn't need them) |

**Never commit to Git:** `.env` files, passwords, API keys, JWT secrets, private keys and certificates, cloud credentials, database dumps with real data. This repo commits only `.env.example` with dummy values, and `.gitignore` excludes `.env*`. If a secret is ever committed, **rotate it**: removing it from history isn't enough, because it may already have been cloned. A secret scanner (gitleaks / GitHub secret scanning) in CI catches mistakes.

### E3. Security checks before accepting an invoice request
Implemented:
- HTTPS (at the load balancer); `helmet` security headers; CORS restricted to the frontend origin.
- Authentication: valid JWT, pinned algorithm (HS256), issuer, audience and expiry checked.
- Authorisation: tenant derived from the token; seller = the user's own company.
- Body size limit (200 KB) and malformed-JSON handling.
- Schema validation (zod): types, required fields, lengths, formats (date, email, currency), numeric ranges and decimal places, max 500 items, **unknown fields rejected**.
- Business validation: totals recalculated server-side; client totals must match.
- Duplicate detection via the unique constraint.
- Parameterised SQL everywhere (no SQL injection), and `LIKE` wildcards escaped in search.
- Rate limiting on login; constant-time login against user enumeration.
- Errors never leak stack traces or SQL; they return a request id instead.

Would add: per-company rate limits/quotas on invoice creation, API keys for machine clients, an audit log, and a check that the user is still active on each request (or short token lifetime plus a revocation list).

---

## Part H – Asynchronous processing

### H1. How it is implemented
A **Postgres-backed job queue** with separate worker processes ([worker.js](../backend/src/worker.js), [invoiceProcessor.js](../backend/src/processing/invoiceProcessor.js)):
1. The API stores the invoice as `PENDING` and returns **202** immediately; it never calls the government.
2. Workers poll every second:
   ```sql
   SELECT id FROM invoices WHERE (status IN ('PENDING','RETRYING') AND next_attempt_at <= now())
                              OR (status = 'PROCESSING' AND locked_until < now())
   LIMIT 10 FOR UPDATE SKIP LOCKED
   ```
   and mark them `PROCESSING` with a **lease** (`locked_by`, `locked_until = now() + 60s`).
   `SKIP LOCKED` lets any number of workers run without picking the same invoice.
3. The worker calls the government API (rate-limited, 5s timeout) and saves the result and the attempt log in one transaction.

**Why Postgres instead of Redis/RabbitMQ?** The invoice and its job are written in the same transaction (no "saved but never queued" gap), there's one less piece of infrastructure, and the job state is queryable with SQL. It comfortably handles thousands of jobs/second. At much larger scale I'd keep this table as the outbox and add a relay that publishes to SQS/RabbitMQ/Kafka (Part K).

### H2. Accepting vs submitting
- **Accepted** (`202`, status `PENDING`): Tubo validated the invoice and durably stored it. Tubo now takes responsibility for delivering it. It does **not** mean the government has it, and the invoice is not legally registered yet.
- **Submitted** (`SUBMITTED`, with a `governmentReference`): the government confirmed receipt. Only now is the invoice official.

They are separated because the government API is slow and unreliable. The customer gets a fast, reliable answer, and delivery is retried in the background. The client sees the progress through the status (dashboard polling; webhooks in production).

### H3. The external API is down for 30 minutes
Nothing is lost: every invoice is safe in the database. Each failed attempt (503 / timeout / network error) is recorded and the invoice goes to `RETRYING` with **exponential backoff and jitter** ([retryPolicy.js](../backend/src/processing/retryPolicy.js)):

| After attempt | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8–13 | 14 |
|---|---|---|---|---|---|---|---|---|---|
| Wait before next (max) | 5s | 10s | 20s | 40s | 80s | 160s | 320s | 600s each (cap) | → FAILED |

Jitter makes each actual wait a random 50–100% of the value above, so the retries from one outage don't all hit the recovering API in the same second. With the production defaults (14 attempts, 5s base, 10-minute cap), the waits add up to between **~35 minutes** (every wait at its shortest) and **~70 minutes** (every wait at its longest), about 53 minutes on average. Even the shortest case outlasts a 30-minute outage, so those invoices recover automatically. A unit test in [retryPolicy.test.js](../backend/test/retryPolicy.test.js) checks this. After the budget is exhausted the invoice is `FAILED`, an alert should fire, and it can be retried with one click or in bulk.

Improvements for long outages: a **circuit breaker** (after N consecutive 503s, all workers pause for a while and send one probe request, instead of every invoice burning attempts), and alerting on "oldest pending invoice age".

400 (invalid) is **not** retried: it's permanent. 401/403 means misconfiguration, so it goes to `FAILED` to get human attention.

---

## Part I – Critical failure scenario

The problem: the government has the invoice, but Tubo's database still says `PROCESSING`. Tubo cannot tell "never arrived" from "arrived but we didn't hear back" (the same thing happens on a timeout).

### I1. What should happen next?
1. The worker crashed, but its **lease** (`locked_until`) expires after 60s. Any worker's claim query then picks the invoice up again (`status = 'PROCESSING' AND locked_until < now()`). Nothing stays stuck.
2. The new worker marks the dead attempt as `ABANDONED` in the attempt log (so support can see the crash) and opens attempt #2.
3. It resends the invoice **with the same `Idempotency-Key`** (the invoice's UUID).
4. The government recognises the key and returns the **original receipt** (same government reference) instead of registering a second invoice.
5. Tubo marks it `SUBMITTED` with that reference. The outcome is correct: one invoice at the government, and Tubo's state is consistent.

(An alternative to step 3: if the government offers a lookup endpoint, first ask "do you have key X?" and only send if not. The mock implements `GET /government-api/invoices/{key}`. The idempotent resend is simpler and needs no extra call.)

This is implemented and demonstrable. See the README "Demo scenarios" (`[timeout]` customer, and `CHAOS_CRASH_AFTER_SUBMIT_RATE=1`).

### I2. How do we prevent a duplicate submission in the external system?
Retrying is unavoidable (we can't know if the first call worked), so the goal is to make **retries safe**, not to avoid them:
- **Idempotency key** = invoice id, which is stable for the invoice's whole life and sent on every attempt. The government stores processed keys and deduplicates. If the same key comes with a *different* payload, it answers 422 (the mock does this too).
- Even without such a header, the natural key *(seller tax id, invoice number)* should be unique at the government, and a "duplicate" answer would be treated as success after verifying it's the same invoice.
- Inside Tubo, only one worker can work on an invoice at a time (`SKIP LOCKED` + lease), and the result is only saved if the worker **still holds the lease** (`UPDATE ... WHERE locked_by = $me AND status = 'PROCESSING'`). This fencing check means a slow worker whose lease expired cannot overwrite the result of the worker that took over.
- The lease (60s) is much longer than the HTTP timeout (5s), so a live worker normally finishes long before its lease could expire.

Exactly-once delivery over a network is impossible. **At-least-once delivery + idempotent receiver = effectively once.**

### I3. Idempotency
An operation is idempotent if doing it several times has the same effect as doing it once. `SET status = 'SUBMITTED'` is idempotent; `balance = balance - 10` is not.

Used here in three places:
1. **Tubo → government:** the `Idempotency-Key` header makes "submit invoice" idempotent, so the worker can retry after timeouts and crashes without creating duplicates.
2. **Client → Tubo:** `(company_id, invoice_number)` acts as a natural idempotency key. A client that retries `POST /invoices` after a network error gets `409` + `existingInvoiceId` instead of a second invoice. (Production: also accept an `Idempotency-Key` header and return the *original* 202 response for a replay.)
3. **Manual retry:** `UPDATE ... WHERE status = 'FAILED'`, so double-clicking Retry only queues it once.

---

## Part J – Concurrency problem

```js
const existingInvoice = await Invoice.findOne({ companyId, invoiceNumber });
if (!existingInvoice) await Invoice.create({ companyId, invoiceNumber, total });
```

1. **Is it safe?** No. It's a *check-then-act* race condition.
2. **What could happen?** Two `INV-10001` rows get created, and the invoice is then submitted to the government twice.
3. **Why do both pass?** The check and the insert are two separate steps, and nothing stops another request from running between them:
   ```
   Request A: findOne → null
   Request B: findOne → null      (A hasn't inserted yet)
   Request A: create  → row 1
   Request B: create  → row 2     duplicate
   ```
   With multiple API servers this can't even be fixed with an in-memory lock, because the requests may be on different machines.
4. **Fix:** let the database decide atomically:
   ```sql
   ALTER TABLE invoices ADD CONSTRAINT invoices_company_number_uq UNIQUE (company_id, invoice_number);
   ```
   ```js
   const { rows } = await db.query(
     `INSERT INTO invoices (company_id, invoice_number, total) VALUES ($1, $2, $3)
      ON CONFLICT (company_id, invoice_number) DO NOTHING RETURNING id`,
     [companyId, invoiceNumber, total]);
   if (rows.length === 0) throw new ConflictError('DUPLICATE_INVOICE', ...);
   ```
   (Or a plain `INSERT` and catch error code `23505 unique_violation`.) The `findOne` can stay as a fast path for a nicer message, but the constraint is what guarantees correctness.
5. **Is application-level validation enough?** No. It's useful for friendly errors, but it can't see uncommitted inserts from other requests or servers. Only the database sees all transactions.
6. **Database mechanism:** a **unique constraint/index** (best: simple, always enforced). Alternatives: `SERIALIZABLE` isolation (works but needs retry logic for serialization failures), or `pg_advisory_xact_lock(hash(company, number))` around check+insert. Those are more complicated and still weaker than a constraint, because they only protect code paths that remember to use them.

---

## Part K – Scalability

### K1. From 10,000 to 1,000,000 invoices/day
1M/day ≈ 12/s on average; with business-hours peaks, plan for **~100–200/s**. That's not huge, but it needs horizontal scaling and no single points of failure.

| Component | Change |
|---|---|
| **API servers** | Stateless (JWT, no sessions), so run N containers behind a **load balancer** (ALB/Nginx) with health checks (`/health`) and autoscaling on CPU/RPS. |
| **Load balancing** | L7 load balancer, TLS termination, per-tenant rate limiting / WAF at the edge. |
| **Database** | Managed Postgres (RDS/Cloud SQL) with a **standby replica for failover**; **PgBouncer** for connection pooling (many containers × pool size would exhaust connections); **read replicas** for dashboard/list/reporting queries; monthly **partitioning** of `invoices`/`attempts` by date, archiving old ones. Sharding by `company_id` only if a single primary becomes the limit (far beyond 1M/day). |
| **Queue** | The outbox stays, but a relay publishes invoice ids to **SQS/RabbitMQ** so workers don't all poll the DB. Separate queues per priority, plus a dead-letter queue. |
| **Workers** | Separate, independently autoscaled deployment (scaled on queue depth / age of oldest message, not CPU). |
| **Caching** | Redis for things read often and changed rarely: company/user lookups, token revocation list, the **shared government rate limiter**. Invoices themselves aren't cached, because their status changes and correctness matters more. |
| **File/object storage** | S3 for signed XML/PDF invoices, government receipts and bulk uploads. Only keys go in the DB. Serve PDFs via pre-signed URLs/CDN. |
| **Logging** | Structured JSON logs (already) with `requestId`/`invoiceId`, shipped to a central store (ELK/Loki/CloudWatch). |
| **Monitoring** | Metrics + dashboards + alerts (see Part N and Q9). Tracing with OpenTelemetry from API → queue → worker → government. |

### K2. 100,000 invoices in 10 minutes, government allows 100 req/s
Arrival rate = 100,000 / 600s ≈ **167/s**, more than the 100/s allowed. So the burst **must** be queued and drained at the permitted rate. That is exactly what the asynchronous design is for. Draining 100k at ~95/s takes ≈ **18 minutes**. The API keeps accepting at full speed (202s) and the queue absorbs the difference.

How the rate is enforced:
- A **global token bucket** shared by all workers (Redis, e.g. a Lua script or `redis-cell`) set slightly *below* the limit (~90/s) for headroom. Today's implementation is a per-worker token bucket ([rateLimiter.js](../backend/src/processing/rateLimiter.js)), so the global limit is configured as `GOV_RATE_LIMIT_PER_SEC × workers ≤ 90`.
- **Bounded concurrency**: each worker handles at most `WORKER_BATCH_SIZE` at a time.
- Treat **429** as retryable with backoff, respect `Retry-After`, and slow down globally (circuit breaker) when 429/503 rates rise.
- **Fairness**: one big company's 100k burst shouldn't delay everyone else. Claim jobs round-robin per company (or use per-tenant queues/quotas).

### K3. Process all of them simultaneously?
No. Firing 100k requests at once would get most of them 429'd or blocked by the government, exhaust our sockets, DB connections and memory, and the retries would amplify the overload (retry storm). Instead, use **controlled concurrency**: pull work in small batches, cap in-flight requests per worker, go through the rate limiter, and scale workers only up to what the slowest dependency (the 100/s limit) allows. Throughput is set by the bottleneck, so the goal is to keep the pipe exactly full, not overflowing.

---

## Part L – Failure & retry design

Each attempt is a row in `invoice_processing_attempts`:

| Requirement | Column |
|---|---|
| when processing started | `started_at` (row inserted *before* the HTTP call) |
| when it ended | `finished_at`, `duration_ms` |
| attempt number | `attempt_number` (unique per invoice) |
| HTTP response | `http_status`, `response_body` (JSONB) |
| error message | `error_message` |
| processing status | `outcome` (`SUCCESS`, `REJECTED`, `RETRYABLE_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, `ERROR`, `ABANDONED`, `IN_PROGRESS`) |
| who processed it | `worker_id` (host-pid) |

For INV-20001 with three failures you'd see e.g.:
```
#3  14:02:41 → 14:02:46  TIMEOUT          –    No response within 5000ms
#2  14:02:31 → 14:02:31  RETRYABLE_ERROR  503  Temporarily unavailable
#1  14:02:25 → 14:02:25  RETRYABLE_ERROR  503  Temporarily unavailable
```

### L1. Overwrite the previous error each time?
**No.** The invoice keeps `last_error` as a convenient *summary* of the current state, but every attempt is **appended** as its own row and never updated after it finishes. Overwriting would destroy the evidence: you couldn't see that attempts 1–2 were 503s (government outage) and attempt 3 was a timeout (a different problem), or how long each took. You also couldn't prove to a customer or auditor what happened and when. For an invoicing (legal/financial) system, an audit trail is a requirement.

### L2. How does support investigate a failure from three days ago?
1. Find the invoice (dashboard filter by number/status, or by `X-Request-Id` the customer quotes).
2. The invoice detail page/API shows the **submission history**: every attempt with times, HTTP status, error, outcome and worker. This answers most cases (government rejected the tax id? outage? timeout?).
3. For more detail, query the raw response:
   ```sql
   SELECT attempt_number, started_at, outcome, http_status, error_message, response_body
     FROM invoice_processing_attempts a JOIN invoices i ON i.id = a.invoice_id
    WHERE i.invoice_number = 'INV-20001' AND i.company_id = '…' ORDER BY attempt_number;
   ```
4. Search the central logs by `invoiceId` / `workerId` for the surrounding context (e.g. that worker crashed, the DB was failing).
5. Check whether it was systemic: count failures by `outcome` and `http_status` around that time (`attempts_started_at_idx`), and check the government API status/latency dashboards for that window.

---

## Part M – API versioning

Strategy: **URL versioning** (`/api/v1`, `/api/v2`), already used here ([app.js](../backend/src/app.js)).
1. **Additive, optional changes stay in v1.** New optional fields don't break anyone, as long as clients ignore unknown response fields (document this as a rule).
2. **A breaking payload change gets a new `/api/v2/invoices`.** v1 keeps working unchanged.
3. **One core, thin adapters per version.** Each version has its own validation schema and DTO mapping, and both translate into the same internal invoice model and service. v1 requests are mapped to the new model with defaults for the new fields. The business logic is not duplicated.
4. **Database changes are backward compatible** (expand → migrate → contract): add new nullable columns or tables first, so v1 and v2 run side by side.
5. **Deprecation process:** announce it, add `Deprecation` and `Sunset` headers to v1 responses with a link to a migration guide, track which customers still call v1 (logs/metrics by API key), contact them, and give a long window (e.g. 6–12 months) before removing it.
6. Contract tests for each version in CI so v2 work can't accidentally break v1.

(The alternative of versioning by header, e.g. `Accept: application/vnd.tubo.v2+json`, keeps URLs clean, but URL versions are more visible and easier to route, log and test.)

---

## Part N – Debugging scenario

*CPU 35%, memory 55%, DB CPU 20%, API normal, external API normal, **150,000 jobs waiting**, **5 workers**, invoices take hours.*

1. **Where to investigate first?** The **workers / queue consumption rate**. Every resource is mostly idle and the dependency is healthy, yet the queue is huge, so the system isn't processing fast enough. Compare *processed per second* with *arriving per second*.
2. **What the metrics suggest:** throughput is limited by **too little concurrency**, not by capacity. For example, if each worker submits one invoice at a time and a call takes ~0.5s, 5 workers ≈ 10/s, so 150,000 jobs take ≈ 4 hours, which matches the complaint. The workers spend most of their time *waiting on network I/O*, which uses almost no CPU. Other possible causes: a rate limiter configured too low, a long poll interval or small batch size, long backoffs, jobs stuck behind expired leases, or poison messages being retried constantly.
3. **More metrics to check:** jobs processed/sec per worker; queue arrival rate; age of the oldest job; government API latency p50/p95 *as seen by the workers*; 429/503 rates; per-worker concurrency/in-flight count; rate-limiter wait time; DB connection pool usage and wait time; lock waits; retry counts and the distribution of outcomes; whether some workers are idle or crash-looping; and whether a single tenant is flooding the queue.
4. **Changes that might improve throughput:**
   - Increase **concurrency per worker** (batch size / parallel requests), since I/O-bound work is cheap.
   - Add **more worker instances** and autoscale on queue depth/age.
   - Raise the rate limit up to (just under) the government's real allowance.
   - Check timeouts and backoff settings; separate retries into their own queue so they don't block fresh invoices.
   - Reduce work per job (avoid extra queries, use keep-alive HTTP connections).
   - Ask the government about bulk-submission endpoints.
5. **Make sure more workers don't overload another component:**
   - A **global rate limiter** for the government API: the limit stays fixed no matter how many workers run.
   - **Connection pooling** (PgBouncer) and a calculated DB connection budget: `workers × pool size ≤ DB max connections`.
   - Scale **gradually** and watch DB CPU, lock waits, government 429s and error rates. Add an autoscaling ceiling.
   - Circuit breakers and backpressure: when the government returns 429/503 or the DB is slow, workers slow down instead of piling on.
   - Load-test the expected peak in staging first.

---

## Part Q – Technical discussion (prepared notes)

1. **Why this architecture?** Correctness first. The API validates and persists in one transaction, and slow or unreliable work is moved to workers. Postgres is the single source of truth and also the queue (transactional outbox), so there is no window where data is in one system but not the other. Fewer moving parts, easy to reason about, and the scaling path (relay to a real queue, more workers) doesn't require a rewrite.

2. **Weakest part?** (be honest)
   - The rate limiter is **per worker**, not global. Running more workers raises the total rate unless the config is adjusted.
   - The worker **polls** the DB; at very high scale that load adds up (fine for this volume; fix = queue + relay or `LISTEN/NOTIFY`).
   - A batch is processed with `Promise.all`, so one slow invoice delays the next claim (bounded by the 5s timeout).
   - No circuit breaker: during an outage each invoice uses up its own retry budget.
   - The JWT is in sessionStorage (XSS-exposable), there's no refresh or revocation, and no roles.
   - No idempotency-key replay for client `POST` (we return 409 instead of replaying the original 202).
   - The frontend has no automated tests; the mock government keeps its state in memory.

3. **With two more days:** a Redis global rate limiter + circuit breaker; a client `Idempotency-Key` header with response replay; Prometheus metrics + a Grafana dashboard (queue depth, oldest-job age, outcomes); Dockerfiles for all services + a full compose stack; an OpenAPI spec generated from zod; httpOnly-cookie auth with refresh tokens; Playwright e2e tests; a bulk retry endpoint for FAILED invoices; a reconciliation job.

4. **Database unavailable?**
   - API: `POST` fails with 500 (nothing is half-written, thanks to transactions); `/health` returns 503, so the load balancer takes instances out and alerts fire. Clients retry; duplicates are prevented by the unique key.
   - Workers: claim queries fail, they log and back off, and resume automatically. An in-flight attempt whose result can't be saved stays `PROCESSING` and is reclaimed after the lease expires, then resent safely thanks to idempotency.
   - Nothing is lost, because accepted invoices are already committed. In production: a managed DB with automatic failover to a standby.

5. **Worker crashes?** Its invoices stay `PROCESSING` with a lease. When `locked_until` passes, another worker reclaims them, marks the old attempt `ABANDONED`, and resends with the same idempotency key. Demonstrated with `CHAOS_CRASH_AFTER_SUBMIT_RATE=1`. A graceful shutdown (SIGTERM) stops claiming and finishes the current batch first.

6. **Preventing duplicate processing?** At three levels: (a) the unique constraint on `(company_id, invoice_number)` means no duplicate invoices; (b) `FOR UPDATE SKIP LOCKED` + lease + the fencing check on `locked_by` mean only one worker owns an invoice at a time; (c) the idempotency key means even an unavoidable resend can't duplicate at the government.

7. **Scaling workers?** Run more worker processes/containers; no coordination is needed thanks to `SKIP LOCKED`. Also tune per-worker concurrency (`WORKER_BATCH_SIZE`). Autoscale on queue depth and oldest-job age. The ceiling is set by the government rate limit (global limiter) and the DB connection budget.

8. **Protecting one company's data from another?** The tenant id comes from the signed token only; every query filters by `company_id`; other tenants' ids return 404; strict schemas block mass assignment; UUIDs aren't enumerable; this is covered by tests. Next steps: Postgres Row-Level Security as defence in depth, and per-tenant rate limits.

9. **Monitoring in production?**
   - *Metrics:* request rate, errors and latency per endpoint (RED); queue depth and **age of the oldest pending invoice** (the best "are we falling behind" signal); attempts/sec by outcome; government latency and 429/503 rate; count of `FAILED`/`REJECTED`; worker count and utilisation; DB connections, CPU, slow queries, replication lag.
   - *Alerts:* oldest pending > N minutes, FAILED spike, government error rate > X%, 5xx rate, health check failures.
   - *Logs:* structured JSON with requestId/invoiceId/workerId, centralised. *Tracing:* OpenTelemetry across API → worker → government.
   - *Business check:* daily reconciliation of submitted counts against the government.

10. **Deploying without interrupting processing?**
    - **Rolling deploys** (or blue/green) behind the load balancer; health checks gate traffic to new instances.
    - API servers drain connections on SIGTERM (implemented in [server.js](../backend/src/server.js)).
    - Workers stop claiming on SIGTERM and finish their current batch (implemented in [worker.js](../backend/src/worker.js)). Anything interrupted is recovered by lease expiry + idempotency, so even a hard kill is safe.
    - **Backward-compatible migrations** (expand → deploy → contract), run once before the rollout (the migration runner uses an advisory lock), so old and new code work with the schema during the rollout.
    - Feature flags for risky changes; canary a small percentage first; quick rollback.
