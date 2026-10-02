// Signed, expiring links for the buttons in owner alert emails ("Mark paid", "Resume chasing"...).
// The link proves the click came from an email WE sent; nobody can forge or edit one without ACTION_SECRET.
const crypto = require('crypto');

function secret() {
  const s = process.env.ACTION_SECRET;
  if (!s || s.length < 16) throw new Error('ACTION_SECRET is missing or shorter than 16 characters');
  return s;
}
const mac = body => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

function sign(payload, ttlHours = 24 * 14) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlHours * 3600 * 1000 })).toString('base64url');
  return `${body}.${mac(body)}`;
}

function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = mac(body);
  const A = Buffer.from(sig), B = Buffer.from(expected);
  if (A.length !== B.length || !crypto.timingSafeEqual(A, B)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp && payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

module.exports = { sign, verify };