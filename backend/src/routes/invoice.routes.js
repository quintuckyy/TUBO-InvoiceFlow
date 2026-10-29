import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { createInvoice, getInvoice, listInvoices, retryInvoice } from '../services/invoice.service.js';
import {
  createInvoiceSchema,
  invoiceIdParamsSchema,
  listInvoicesQuerySchema,
} from '../validation/invoice.schema.js';

export const invoiceRouter = Router();

invoiceRouter.use(requireAuth);

// 202 Accepted: the invoice is stored and queued, NOT yet submitted to the government.
invoiceRouter.post('/', validate(createInvoiceSchema), async (req, res) => {
  const invoice = await createInvoice({
    companyId: req.auth.companyId,
    userId: req.auth.userId,
    input: req.valid.body,
  });
  res.status(202).location(`${req.baseUrl}/${invoice.id}`).json({ data: invoice });
});

invoiceRouter.get('/', validate(listInvoicesQuerySchema, 'query'), async (req, res) => {
  res.json(await listInvoices({ companyId: req.auth.companyId, filters: req.valid.query }));
});

invoiceRouter.get('/:id', validate(invoiceIdParamsSchema, 'params'), async (req, res) => {
  const invoice = await getInvoice({ companyId: req.auth.companyId, invoiceId: req.valid.params.id });
  res.json({ data: invoice });
});

invoiceRouter.post('/:id/retry', validate(invoiceIdParamsSchema, 'params'), async (req, res) => {
  const invoice = await retryInvoice({ companyId: req.auth.companyId, invoiceId: req.valid.params.id });
  res.status(202).json({ data: invoice });
});
