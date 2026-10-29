import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateInvoiceTotals, calculateLine, formatScaled, parseScaled } from '../src/lib/money.js';

test('parseScaled converts decimals to scaled integers without floating point', () => {
  assert.equal(parseScaled('12.5', 2), 1250);
  assert.equal(parseScaled(0.1, 2), 10);
  assert.equal(parseScaled('3', 3), 3000);
  assert.equal(parseScaled('1.2345', 2), null); // too many decimals
  assert.equal(parseScaled('-1', 2), null); // negative
  assert.equal(parseScaled('abc', 2), null);
});

test('formatScaled pads fractions', () => {
  assert.equal(formatScaled(1205, 2), '12.05');
  assert.equal(formatScaled(7, 2), '0.07');
  assert.equal(formatScaled(1500, 3), '1.500');
});

test('calculateLine rounds half up', () => {
  // 3 x 0.333 = 0.999 -> 1.00 ; 12% tax of 1.00 = 0.12
  assert.deepEqual(calculateLine({ quantityMilli: 3000, unitPriceCents: 33, taxRateBp: 1200 }), {
    lineSubtotalCents: 99,
    taxCents: 12,
    lineTotalCents: 111,
  });
  // 1.5 x 0.15 = 0.225 -> 0.23
  assert.equal(calculateLine({ quantityMilli: 1500, unitPriceCents: 15, taxRateBp: 0 }).lineSubtotalCents, 23);
});

test('calculateInvoiceTotals sums lines and keeps total = subtotal + tax', () => {
  const totals = calculateInvoiceTotals([
    { quantityMilli: 2000, unitPriceCents: 15000, taxRateBp: 1200 }, // 300.00 + 36.00
    { quantityMilli: 1000, unitPriceCents: 1010, taxRateBp: 1250 }, // 10.10 + 1.26 (1.2625)
  ]);
  assert.equal(totals.subtotalCents, 31010);
  assert.equal(totals.taxCents, 3726);
  assert.equal(totals.totalCents, 34736);
});

test('large values do not lose precision', () => {
  // 1,000,000 units x 999,999,999.99
  const line = calculateLine({ quantityMilli: 1_000_000_000, unitPriceCents: 99_999_999_999, taxRateBp: 0 });
  assert.equal(line.lineSubtotalCents, 99_999_999_999_000_000);
});
