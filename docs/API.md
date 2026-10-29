# Tubo API v1

Base URL: `http://localhost:4000/api/v1` (`/api/...` is an alias of v1).
All endpoints except login need `Authorization: Bearer <token>`.

Errors always have this shape:
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed", "details": [ { "path": "items.0.quantity", "message": "Quantity must be greater than 0" } ] } }
```
Every response carries an `X-Request-Id` header. Quote it to support.

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `MALFORMED_JSON` | Bad input (also unknown fields like `companyId`) |
| 401 | `UNAUTHORIZED` | Missing, invalid or expired token; bad login |
| 404 | `NOT_FOUND` | Not found **or belongs to another company** |
| 409 | `DUPLICATE_INVOICE` | Invoice number already used by this company (`details.existingInvoiceId`) |
| 409 | `INVOICE_NOT_RETRYABLE` | Retry requested for an invoice that is not `FAILED` |
| 413 | `PAYLOAD_TOO_LARGE` | Body > 200 KB |
| 422 | `TOTALS_MISMATCH` | Client-sent totals differ from the calculated ones |
| 429 | | Too many login attempts |

---

## POST /auth/login
```bash
curl -s localhost:4000/api/v1/auth/login -H "content-type: application/json" \
  -d '{"email":"usera@abc.test","password":"Password123!"}'
```
`200` → `{ "token": "eyJ...", "user": { "id", "email", "fullName", "company": { "id", "name" } } }`

## GET /auth/me
`200` → `{ "user": { ... } }`

## POST /invoices
Creates an invoice and queues it for government submission.
```bash
curl -s localhost:4000/api/v1/invoices -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{
  "invoiceNumber": "INV-10001",
  "invoiceDate": "2026-10-29",
  "customerName": "Acme Ltd",
  "customerTaxId": "ACME-123",
  "customerEmail": "billing@acme.test",
  "currency": "USD",
  "items": [
    { "description": "Consulting", "quantity": "2", "unitPrice": "150.00", "taxRate": "12" },
    { "description": "Travel",     "quantity": 1,   "unitPrice": 80.5,     "taxRate": 0 }
  ]
}'
```
| Field | Rules |
|---|---|
| invoiceNumber | required, ≤ 50 chars, letters/digits/`-_/.`, unique per company |
| invoiceDate | `YYYY-MM-DD`, real calendar date |
| customerName / customerTaxId | required |
| customerEmail | valid email |
| currency | 3-letter ISO code (upper-cased) |
| items | 1–500 items |
| items[].quantity | > 0, ≤ 3 decimals |
| items[].unitPrice | ≥ 0, ≤ 2 decimals |
| items[].taxRate | percent 0–100, ≤ 2 decimals |
| subtotal / taxAmount / totalAmount | optional; if sent they must match the server calculation |

Numbers may be sent as JSON numbers or strings. Amounts are **returned as strings** (`"336.00"`) to keep decimal precision.

`202 Accepted` + `Location: /api/v1/invoices/{id}`, body `{ "data": <invoice detail> }` with `status: "PENDING"`.

## GET /invoices
Query: `status`, `invoiceNumber` (prefix, case-insensitive), `dateFrom`, `dateTo` (`YYYY-MM-DD`), `page` (default 1), `pageSize` (1–100, default 20).
```bash
curl -s "localhost:4000/api/v1/invoices?status=FAILED&page=1&pageSize=20" -H "authorization: Bearer $TOKEN"
```
```json
{
  "data": [ { "id": "…", "invoiceNumber": "INV-10001", "invoiceDate": "2026-10-29", "customerName": "Acme Ltd",
              "currency": "USD", "subtotal": "380.50", "taxAmount": "36.00", "totalAmount": "416.50",
              "status": "SUBMITTED", "canRetry": false,
              "processing": { "attemptCount": 1, "nextAttemptAt": null, "lastError": null,
                              "governmentReference": "GOV-1A2B3C4D", "submittedAt": "…" }, "createdAt": "…", "updatedAt": "…" } ],
  "pagination": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
}
```

## GET /invoices/{id}
Same as a list item plus:
```json
{
  "seller": { "companyId": "…", "name": "ABC Corporation", "taxId": "ABC-TAX-0001" },
  "items": [ { "lineNumber": 1, "description": "Consulting", "quantity": "2.000", "unitPrice": "150.00",
               "taxRate": "12.00", "lineSubtotal": "300.00", "taxAmount": "36.00", "lineTotal": "336.00" } ],
  "attempts": [ { "attemptNumber": 2, "workerId": "host-1234-ab12cd34", "startedAt": "…", "finishedAt": "…",
                  "durationMs": 412, "outcome": "SUCCESS", "httpStatus": 200, "errorMessage": null },
                { "attemptNumber": 1, "outcome": "TIMEOUT", "httpStatus": null, "errorMessage": "No response within 5000ms", "…": "…" } ]
}
```
Attempt outcomes: `IN_PROGRESS`, `SUCCESS`, `REJECTED`, `RETRYABLE_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, `ERROR`, `ABANDONED` (worker died mid-attempt).

## POST /invoices/{id}/retry
Only for `FAILED` invoices. Puts the invoice back to `PENDING` with a fresh automatic-retry budget.
`202` → `{ "data": <invoice detail> }`, otherwise `409 INVOICE_NOT_RETRYABLE` / `404`.

## GET /health
`200 {"status":"ok"}` or `503 {"status":"database_unavailable"}`. Used by the load balancer.

---

## Mock government API (port 4001)
| Endpoint | |
|---|---|
| `POST /government-api/invoices` | Needs `Authorization: Bearer $GOV_API_KEY` and `Idempotency-Key`. Returns 200 receipt / 400 / 503 / 429 / slow response |
| `GET /government-api/invoices/{idempotencyKey}` | Look up a receipt (reconciliation) |
| `POST /government-api/_admin/outage` `{"enabled": true}` | Simulate a full outage |
