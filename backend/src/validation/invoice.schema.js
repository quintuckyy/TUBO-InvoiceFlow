import { z } from 'zod';
import { parseScaled } from '../lib/money.js';

export const INVOICE_STATUSES = ['PENDING', 'PROCESSING', 'RETRYING', 'SUBMITTED', 'FAILED', 'REJECTED'];

const MAX_QUANTITY_MILLI = 1_000_000 * 1000; // 1,000,000 units
const MAX_UNIT_PRICE_CENTS = 1_000_000_000 * 100; // 1,000,000,000.00

/** Accepts "12.50" or 12.5 and converts to a scaled integer (see lib/money.js). */
function decimal(decimals, label) {
  return z.union([z.string(), z.number()]).transform((value, ctx) => {
    const scaled = parseScaled(value, decimals);
    if (scaled === null) {
      ctx.addIssue({
        code: 'custom',
        message: `${label} must be a non-negative number with at most ${decimals} decimal places`,
      });
      return z.NEVER;
    }
    return scaled;
  });
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, 'Must be a valid calendar date');

const invoiceItemSchema = z
  .object({
    description: z.string().trim().min(1, 'Description is required').max(500),
    quantity: decimal(3, 'Quantity')
      .refine((q) => q > 0, 'Quantity must be greater than 0')
      .refine((q) => q <= MAX_QUANTITY_MILLI, 'Quantity is too large'),
    unitPrice: decimal(2, 'Unit price').refine((p) => p <= MAX_UNIT_PRICE_CENTS, 'Unit price is too large'),
    taxRate: decimal(2, 'Tax rate').refine((r) => r <= 10000, 'Tax rate must be between 0 and 100'),
  })
  .strict();

// .strict() rejects unknown fields. In particular a client cannot send "companyId" or "status":
// the company always comes from the authenticated token and the status from the server.
export const createInvoiceSchema = z
  .object({
    invoiceNumber: z
      .string()
      .trim()
      .min(1, 'Invoice number is required')
      .max(50)
      .regex(/^[A-Za-z0-9][A-Za-z0-9\-_/.]*$/, 'Only letters, digits and - _ / . are allowed'),
    invoiceDate: isoDate,
    customerName: z.string().trim().min(1, 'Customer name is required').max(200),
    customerTaxId: z.string().trim().min(1, 'Customer tax ID is required').max(50),
    customerEmail: z.string().trim().email('Must be a valid email address').max(254),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'Must be a 3-letter ISO 4217 currency code'),
    items: z.array(invoiceItemSchema).min(1, 'At least one item is required').max(500),
    // Optional client-calculated totals. If sent, they must match the server calculation.
    subtotal: decimal(2, 'Subtotal').optional(),
    taxAmount: decimal(2, 'Tax amount').optional(),
    totalAmount: decimal(2, 'Total amount').optional(),
  })
  .strict();

export const listInvoicesQuerySchema = z.object({
  status: z.enum(INVOICE_STATUSES).optional(),
  invoiceNumber: z.string().trim().min(1).max(50).optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const invoiceIdParamsSchema = z.object({
  id: z.string().uuid(),
});
