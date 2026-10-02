// Money is stored as integer cents everywhere, so totals never drift by a fraction of a cent.
function toCents(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  let s = String(input).trim().replace(/[^\d.,-]/g, '');
  if (!s || s === '-') return null;
  // "1.234,56" / "1234,56" (comma as the decimal mark) vs "1,234.56"
  if (/,\d{1,2}$/.test(s) && (!s.includes('.') || s.lastIndexOf(',') > s.lastIndexOf('.'))) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const formatMoney = (cents, currency = 'USD', locale = 'en-US') =>
  new Intl.NumberFormat(locale, { style: 'currency', currency }).format((Number(cents) || 0) / 100);

// What the customer still owes on an invoice.
const balanceCents = inv => Math.max(0, Number(inv.amount_cents || 0) - Number(inv.amount_paid_cents || 0));

module.exports = { toCents, formatMoney, balanceCents };