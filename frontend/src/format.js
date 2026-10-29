// Amounts arrive from the API as exact decimal strings ("1234.50"); only format for display.
export function formatMoney(amount, currency) {
  const [whole, fraction = '00'] = String(amount).split('.');
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0')}`;
}

export function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : '—';
}
