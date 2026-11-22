// ONE function for every Microsoft-mailbox page (so we stay under Vercel's free 12-function limit):
//   /api/mail/connect?secret=...   start the Microsoft sign-in (you, the owner, open this in a browser)
//   /api/mail/callback             where Microsoft sends you back (protected by a signed cookie, no secret needed)
//   /api/mail/status?secret=...    shows which mailbox is connected (never shows a token)
//   /api/mail/test?secret=...      sends ONE test email to the connected mailbox (or to you) and lists unread mail.
//                                  Add &send=0 to only read.  It can never email anyone else.
const crypto = require('crypto');
const { isCronAuthorized } = require('../../lib/auth');
const { supabase, must } = require('../../lib/db');
const { esc } = require('../../lib/util');
const { getConfig } = require('../../lib/config');
const { signValue, verifyValue, encrypt } = require('../../lib/mail/crypto');
const oauth = require('../../lib/mail/oauth');
const graph = require('../../lib/mail/graph');

const page = (res, status, title, html) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;background:#f4f6f5;color:#1c2421;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}main{max-width:560px;margin:12vh auto;padding:0 20px}h1{font-size:21px;margin:0 0 10px}p{margin:0 0 12px}.meta{color:#5b6b64;font-size:14px}code{background:#e7ece9;padding:1px 5px;border-radius:3px}</style><main><h1>${esc(title)}</h1>${html}</main></html>`);
};
const cookieOf = (req, name) => String(req.headers && req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).find(([k]) => k === name)?.slice(1).join('=') || '';
const clearCookie = res => res.setHeader('Set-Cookie', 'mail_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/mail; Max-Age=0');

async function accountRow() {
  return must(await supabase.from('mail_accounts').select('*').eq('provider', 'graph').limit(1))[0] || null;
}

module.exports = async (req, res) => {
  const action = String((req.query && req.query.action) || '');
  const q = req.query || {};
  try {
    // ---- where Microsoft sends you back after you sign in ----
    if (action === 'callback') {
      if (q.error) { clearCookie(res); return page(res, 400, 'Microsoft sign-in was not completed', `<p>${esc(q.error)}: ${esc(String(q.error_description || '').slice(0, 300))}</p><p class="meta">Nothing was saved. Start again from the connect link.</p>`); }
      const saved = verifyValue(cookieOf(req, 'mail_oauth'));
      if (!saved || !q.state || q.state !== saved.s || !q.code) { clearCookie(res); return page(res, 400, 'This sign-in link is not valid or has expired', '<p class="meta">Nothing was saved. Start again from the connect link.</p>'); }
      clearCookie(res);

      const t = await oauth.exchangeCode(String(q.code), saved.v);
      const granted = String(t.scope || '').toLowerCase();
      if (!t.refresh_token || !granted.includes('mail.send') || !granted.includes('mail.readwrite')) {
        return page(res, 400, 'Not all permissions were granted', '<p>The mailbox must allow reading and sending mail. Nothing was saved. Start again and accept every permission.</p>');
      }
      const me = await oauth.whoAmI(t.access_token);
      const want = String(process.env.MAIL_EXPECTED_ADDRESS || '').trim().toLowerCase();
      if (!me.address) return page(res, 400, 'Could not read the mailbox address', '<p class="meta">Nothing was saved.</p>');
      if (want && want !== me.address) return page(res, 400, 'That is not the mailbox we expected', `<p>You signed in as <code>${esc(me.address)}</code>, but this system expects <code>${esc(want)}</code>. Nothing was saved.</p>`);

      const row = {
        provider: 'graph', address: me.address, tenant_id: oauth.claimsOf(t.id_token).tid || null,
        refresh_token_encrypted: encrypt(t.refresh_token), access_token_encrypted: encrypt(t.access_token),
        access_expires_at: new Date(Date.now() + Number(t.expires_in || 3600) * 1000).toISOString(),
        status: 'connected', last_ok_at: new Date().toISOString(), last_error: null
      };
      const existing = await accountRow();
      if (existing) must(await supabase.from('mail_accounts').update(row).eq('id', existing.id));
      else must(await supabase.from('mail_accounts').insert(row));
      return page(res, 200, 'Connected', `<p>Connected as <code>${esc(me.address)}</code>. You can close this tab.</p><p class="meta">Next: open the <code>/api/mail/test</code> address to send a test email.</p>`);
    }

    // ---- everything else is for the owner only ----
    if (!isCronAuthorized(req)) return res.status(401).end();

    if (action === 'connect') {
      const missing = ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MAIL_TOKEN_KEY', 'APP_DOMAIN'].filter(k => !String(process.env[k] || '').trim());
      if (missing.length) return page(res, 500, 'Some settings are missing', `<p>Add these in Vercel (Settings, Environment Variables) and redeploy: <code>${esc(missing.join(', '))}</code></p>`);
      const { verifier, challenge } = oauth.pkcePair();
      const state = crypto.randomBytes(16).toString('hex');
      res.setHeader('Set-Cookie', `mail_oauth=${signValue({ s: state, v: verifier })}; HttpOnly; Secure; SameSite=Lax; Path=/api/mail; Max-Age=600`);
      res.writeHead(302, { Location: oauth.authorizeUrl({ state, challenge }) });
      return res.end();
    }

    if (action === 'status') {
      const r = await accountRow();
      return res.status(200).json({
        connected: !!r && r.status === 'connected', address: r ? r.address : null, status: r ? r.status : 'not_connected', tenantId: r ? r.tenant_id : null,
        lastOk: r ? r.last_ok_at : null, lastError: r ? r.last_error : null, accessTokenValidUntil: r ? r.access_expires_at : null,
        redirectUri: oauth.redirectUri(),
        settings: { MS_CLIENT_ID: !!process.env.MS_CLIENT_ID, MS_CLIENT_SECRET: !!process.env.MS_CLIENT_SECRET, MAIL_TOKEN_KEY: !!process.env.MAIL_TOKEN_KEY, MAIL_EXPECTED_ADDRESS: !!process.env.MAIL_EXPECTED_ADDRESS }
      });
    }

    if (action === 'test') {
      const r = await accountRow();
      if (!r) return res.status(400).json({ error: 'No mailbox is connected yet. Open /api/mail/connect first.' });
      const owner = String(getConfig().business.ownerEmail || '').toLowerCase();
      const to = String(q.to || r.address).toLowerCase();
      if (![r.address.toLowerCase(), owner].includes(to)) return res.status(400).json({ error: 'The test email can only go to the connected mailbox or to the owner address.' });
      let sent = null;
      if (q.send !== '0') {
        const when = new Date().toISOString();
        const s = await graph.sendMail({ to, subject: 'Invoice Chaser: Microsoft mailbox test', text: `This is a test sent through Microsoft Graph at ${when}. Nothing else was sent.`, html: `<p>This is a test sent through Microsoft Graph at ${esc(when)}.</p><p>Nothing else was sent.</p>` });
        sent = { to, hasMessageId: !!s.messageId, hasConversationId: !!s.conversationId };
      }
      const unread = await graph.fetchUnread({ sinceDays: 3, max: 5 });
      return res.status(200).json({ ok: true, mailbox: r.address, sent, unreadCount: unread.length, unread: unread.map(m => ({ from: m.from.address, subject: m.subject, to: m.to, hasConversationId: !!m.conversationId })) });
    }

    return res.status(404).json({ error: 'unknown action' });
  } catch (e) {
    console.error('mail route failed:', e.message);
    const auth = e instanceof oauth.MailAuthError;
    return res.status(auth ? 401 : 500).json({ error: e.message, ...(auth ? { hint: 'Open /api/mail/connect to reconnect the mailbox.' } : {}) });
  }
};