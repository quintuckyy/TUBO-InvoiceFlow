import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js';
import { authRouter } from './routes/auth.routes.js';
import { invoiceRouter } from './routes/invoice.routes.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one load balancer: use its X-Forwarded-For for rate limiting
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '200kb' }));
  app.use(requestContext);

  // Liveness/readiness for the load balancer: fails if the database is unreachable.
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database_unavailable' });
    }
  });

  const v1 = express.Router();
  v1.use('/auth', authRouter);
  v1.use('/invoices', invoiceRouter);

  app.use('/api/v1', v1);
  // Unversioned alias kept for the paths in the assessment brief; it points at v1.
  // A future /api/v2 would be mounted next to v1 without changing it (see docs/ANSWERS.md, Part M).
  app.use('/api', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
