import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

// Gives every request an id (or keeps the one from the load balancer) and logs one line
// per request. The id is returned in X-Request-Id so a customer can quote it to support.
export function requestContext(req, res, next) {
  req.id = req.get('x-request-id') ?? randomUUID();
  res.set('X-Request-Id', req.id);
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    logger.info('request', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      companyId: req.auth?.companyId,
    });
  });
  next();
}
