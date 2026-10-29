// Money maths in integers. Floating point cannot represent 0.1 exactly
// (0.1 + 0.2 = 0.30000000000000004), so all amounts are converted to scaled integers:
//   money     -> cents        (2 decimals)
//   quantity  -> thousandths  (3 decimals)
//   tax rate  -> basis points (2 decimals of a percent, 12.5% = 1250)
// BigInt is used for multiplication so large quantity * price cannot overflow.

/**
 * Parses a non-negative decimal (string or number) into a scaled integer.
 * parseScaled("12.5", 2) -> 1250. Returns null if the value is not a valid decimal
 * or has more decimal places than allowed.
 */
export function parseScaled(value, decimals) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  const match = new RegExp(`^(\\d{1,15})(?:\\.(\\d{1,${decimals}}))?$`).exec(text);
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(decimals, '0');
  return Number(match[1]) * 10 ** decimals + Number(fraction || 0);
}

/** formatScaled(1250, 2) -> "12.50". Works on integers, never on floats. */
export function formatScaled(scaled, decimals) {
  const factor = 10 ** decimals;
  const whole = Math.floor(scaled / factor);
  const fraction = String(scaled % factor).padStart(decimals, '0');
  return decimals === 0 ? String(whole) : `${whole}.${fraction}`;
}

export const formatCents = (cents) => formatScaled(cents, 2);

/** Integer division rounding half up (inputs are non-negative BigInts). */
function divRoundHalfUp(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

/**
 * @param {{quantityMilli:number, unitPriceCents:number, taxRateBp:number}} item
 */
export function calculateLine({ quantityMilli, unitPriceCents, taxRateBp }) {
  const lineSubtotal = divRoundHalfUp(BigInt(quantityMilli) * BigInt(unitPriceCents), 1000n);
  const tax = divRoundHalfUp(lineSubtotal * BigInt(taxRateBp), 10000n);
  return {
    lineSubtotalCents: Number(lineSubtotal),
    taxCents: Number(tax),
    lineTotalCents: Number(lineSubtotal + tax),
  };
}

/** Tax is rounded per line, then summed - the usual e-invoicing convention. */
export function calculateInvoiceTotals(items) {
  const lines = items.map((item) => ({ ...item, ...calculateLine(item) }));
  const subtotalCents = lines.reduce((sum, l) => sum + l.lineSubtotalCents, 0);
  const taxCents = lines.reduce((sum, l) => sum + l.taxCents, 0);
  return { lines, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}
