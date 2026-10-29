const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Token bucket: holds up to `ratePerSec` tokens, refilled continuously at `ratePerSec`/second.
 * Each government API call takes one token, so this process never exceeds the rate.
 *
 * This limit is per worker process. With N workers set GOV_RATE_LIMIT_PER_SEC = limit / N,
 * or move the bucket to Redis to share it (see docs/ANSWERS.md, Part K2).
 */
export function createRateLimiter(ratePerSec) {
  let tokens = ratePerSec;
  let lastRefill = Date.now();

  return {
    async acquire() {
      for (;;) {
        const now = Date.now();
        tokens = Math.min(ratePerSec, tokens + ((now - lastRefill) / 1000) * ratePerSec);
        lastRefill = now;
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        await sleep(Math.ceil(((1 - tokens) / ratePerSec) * 1000));
      }
    },
  };
}
