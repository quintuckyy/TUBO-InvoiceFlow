import { config } from '../config.js';

/**
 * Sends one invoice to the government API. Never throws: every possible result is turned into
 * an outcome the worker can store and act on.
 *
 * The Idempotency-Key is the invoice's own id, which never changes. If we send the same invoice
 * twice (because we crashed, or timed out, before learning the first result), the government
 * recognises the key and returns the ORIGINAL receipt instead of registering a second invoice.
 */
export async function submitToGovernment(payload, idempotencyKey) {
  let response;
  try {
    response = await fetch(`${config.gov.baseUrl}/government-api/invoices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.gov.apiKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.gov.timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      // Unknown outcome: the government may or may not have processed it. Safe to retry
      // only because of the idempotency key.
      return { outcome: 'TIMEOUT', httpStatus: null, body: null, error: `No response within ${config.gov.timeoutMs}ms` };
    }
    return { outcome: 'NETWORK_ERROR', httpStatus: null, body: null, error: err.message };
  }

  let body = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return { outcome: 'TIMEOUT', httpStatus: response.status, body: null, error: 'Timed out reading response body' };
    }
    body = { unparseable: true };
  }

  const outcome = classifyStatus(response.status);
  const error = outcome === 'SUCCESS' ? null : (body?.error?.message ?? `Government API responded HTTP ${response.status}`);
  return { outcome, httpStatus: response.status, body, error };
}

export function classifyStatus(status) {
  if (status >= 200 && status < 300) return 'SUCCESS';
  if (status === 400 || status === 422) return 'REJECTED'; // invalid invoice: permanent
  if (status === 408 || status === 429 || status >= 500) return 'RETRYABLE_ERROR'; // temporary
  return 'ERROR'; // e.g. 401/403/404: configuration problem, retrying won't fix it
}
