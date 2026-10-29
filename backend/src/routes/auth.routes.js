import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getCurrentUser, login } from '../services/auth.service.js';
import { loginSchema } from '../validation/auth.schema.js';

export const authRouter = Router();

// Brute-force protection: 10 login attempts per IP per 15 minutes.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

authRouter.post('/login', loginLimiter, validate(loginSchema), async (req, res) => {
  const { email, password } = req.valid.body;
  res.json(await login(email, password));
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json({ user: await getCurrentUser(req.auth.userId) });
});
