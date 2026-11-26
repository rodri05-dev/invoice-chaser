// "Sign in with Microsoft" (authorization code flow with PKCE) and the token calls. Plain fetch, no SDK.
// The app is registered as multi-tenant + personal accounts, so the "common" address works for both a
// company mailbox and a free outlook.com mailbox.
const crypto = require('crypto');

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const SCOPES = 'openid offline_access Mail.ReadWrite Mail.Send User.Read';

class MailAuthError extends Error {}

let fetchImpl = (...a) => fetch(...a);            // the tests swap this for a fake
const setFetch = f => { fetchImpl = f; };

const redirectUri = () => `https://${String(process.env.APP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/mail/callback`;

const challengeFor = verifier => crypto.createHash('sha256').update(verifier).digest('base64url');
function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');      // 64 random characters
  return { verifier, challenge: challengeFor(verifier) };
}

function authorizeUrl({ state, challenge }) {
  const p = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(), response_mode: 'query',
    scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'
  });
  return `${AUTHORITY}/authorize?${p}`;
}

async function tokenCall(params) {
  const body = new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET, scope: SCOPES, ...params });
  const res = await fetchImpl(`${AUTHORITY}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new MailAuthError(`${json.error || res.status}: ${String(json.error_description || '').split('\r\n')[0]}`.slice(0, 300));
    e.code = json.error; e.status = res.status;
    throw e;
  }
  return json;
}

const exchangeCode = (code, verifier) => tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
const refresh = refreshToken => tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken });

// Who just signed in? (The address of the mailbox we are being connected to.)
async function whoAmI(accessToken) {
  const res = await fetchImpl('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new MailAuthError(`Could not read the signed-in mailbox (${res.status})`);
  const j = await res.json().catch(() => ({}));
  return { address: String(j.mail || j.userPrincipalName || '').toLowerCase(), name: j.displayName || '' };
}

// The id_token comes straight from Microsoft's token address over HTTPS, so reading it (not trusting anyone else's copy) is fine.
function claimsOf(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

module.exports = { MailAuthError, setFetch, redirectUri, challengeFor, pkcePair, authorizeUrl, exchangeCode, refresh, whoAmI, claimsOf, SCOPES };