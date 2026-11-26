// Small pure helpers shared across the project.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const normEmail = v => {
  const e = String(v || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
};

// "(555) 123-4567" -> "+15551234567". PHONE_COUNTRY_CODE says what a number WITHOUT a country prefix means:
// 1 = US/Canada (default), 33 = France ("06 12 34 56 78" -> +33612345678), 377 = Monaco.
function normPhone(v) {
  const country = String(process.env.PHONE_COUNTRY_CODE || '1').replace(/\D/g, '');
  const raw = String(v || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 8) return `+${digits}`;
  if (raw.startsWith('00') && digits.length >= 10) return `+${digits.slice(2)}`;          // 0033 6 12 34 56 78
  if (country === '1') {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  } else if (digits.startsWith('0') && digits.length >= 9) return `+${country}${digits.slice(1)}`;
  return digits.length >= 8 ? `+${digits}` : null;
}

const escapeRegExp = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { esc, normEmail, normPhone, escapeRegExp };