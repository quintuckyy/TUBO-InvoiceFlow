// Central place for configuration. Everything comes from environment variables
// so secrets never live in source code (see .env.example).

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function number(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} must be a number`);
  return value;
}

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: number('PORT', 4000),
  databaseUrl: required('DATABASE_URL'),
  dbPoolMax: number('DB_POOL_MAX', 10),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',

  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
    issuer: 'tubo-api',
    audience: 'tubo-clients',
  },

  gov: {
    baseUrl: process.env.GOV_API_BASE_URL ?? 'http://localhost:4001',
    apiKey: required('GOV_API_KEY'),
    timeoutMs: number('GOV_TIMEOUT_MS', 5000),
    rateLimitPerSec: number('GOV_RATE_LIMIT_PER_SEC', 20),
  },

  worker: {
    batchSize: number('WORKER_BATCH_SIZE', 10),
    pollIntervalMs: number('WORKER_POLL_INTERVAL_MS', 1000),
    // Must comfortably exceed the time one batch can take (rate-limit wait + GOV timeout).
    leaseSeconds: number('WORKER_LEASE_SECONDS', 60),
    // 14 attempts = 13 backoff waits: 35-70 min of retrying depending on jitter,
    // so even the shortest case outlasts a 30-minute outage (see test/retryPolicy.test.js).
    maxAutoAttempts: number('MAX_AUTO_ATTEMPTS', 14),
    backoffBaseMs: number('BACKOFF_BASE_MS', 5000),
    backoffMaxMs: number('BACKOFF_MAX_MS', 10 * 60 * 1000),
    chaosCrashAfterSubmitRate: number('CHAOS_CRASH_AFTER_SUBMIT_RATE', 0),
  },
};
