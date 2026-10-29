/**
 * Exponential backoff with jitter.
 * attempt 1 -> ~base, 2 -> ~2*base, 3 -> ~4*base ... capped at maxMs.
 * "Equal jitter": half the delay is fixed, half is random. Without jitter, thousands of invoices
 * that failed during the same outage would all retry at the same instant and knock the
 * recovering API over again (thundering herd).
 */
export function computeBackoffMs(attempt, { baseMs, maxMs }, random = Math.random) {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

/** Outcomes where trying again later can succeed. */
export const RETRYABLE_OUTCOMES = new Set(['RETRYABLE_ERROR', 'TIMEOUT', 'NETWORK_ERROR']);

/**
 * Decides what happens to the invoice after an attempt.
 * @returns {{ status: string, nextAttemptAt: Date|null }}
 */
export function decideNextStep(outcome, attemptsInCycle, policy, now = Date.now()) {
  if (outcome === 'SUCCESS') return { status: 'SUBMITTED', nextAttemptAt: null };
  if (outcome === 'REJECTED') return { status: 'REJECTED', nextAttemptAt: null };
  if (RETRYABLE_OUTCOMES.has(outcome) && attemptsInCycle < policy.maxAutoAttempts) {
    return { status: 'RETRYING', nextAttemptAt: new Date(now + computeBackoffMs(attemptsInCycle, policy)) };
  }
  // Retries exhausted, or a non-retryable error such as 401 (bad API key): needs a human.
  return { status: 'FAILED', nextAttemptAt: null };
}
