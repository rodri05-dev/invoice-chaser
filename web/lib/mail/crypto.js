// Protects the Microsoft sign-in tokens. They are encrypted (AES-256-GCM) before they are saved in the database,
// and the short-lived sign-in cookie is signed so nobody can forge it. The key is MAIL_TOKEN_KEY:
// 64 hex characters (32 random bytes). Never log a token or the key.
const crypto = require('crypto');

function keyBytes() {
  const hex = String(process.env.MAIL_TOKEN_KEY || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('MAIL_TOKEN_KEY must be 64 hex characters (32 random bytes)');
  return Buffer.from(hex, 'hex');
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(blob) {
  const [v, iv, tag, enc] = String(blob || '').split(':');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('Unreadable encrypted value');
  const d = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

const signKey = () => crypto.createHash('sha256').update('mail-sign:').update(keyBytes()).digest();

function signValue(obj, ttlSeconds = 600) {
  const body = Buffer.from(JSON.stringify({ ...obj, exp: Date.now() + ttlSeconds * 1000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', signKey()).update(body).digest('base64url')}`;
}

function verifyValue(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const good = crypto.createHmac('sha256', signKey()).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return o.exp > Date.now() ? o : null;
  } catch { return null; }
}

module.exports = { encrypt, decrypt, signValue, verifyValue };