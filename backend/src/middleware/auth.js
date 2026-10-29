import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { UnauthorizedError } from '../lib/errors.js';

/**
 * Verifies the Bearer JWT and exposes req.auth = { userId, companyId }.
 * companyId comes ONLY from the signed token - never from the URL or body - and every
 * invoice query is filtered by it. That is what stops User A reading Company B's data.
 */
export function requireAuth(req, _res, next) {
  const [scheme, token] = (req.get('authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new UnauthorizedError();

  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'], // pin the algorithm; never accept "none"
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }

  req.auth = { userId: payload.sub, companyId: payload.companyId };
  next();
}
