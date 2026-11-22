// Sending and reading mail through Microsoft Graph, as the ONE mailbox that signed in (delegated access).
// Same shape of results as lib/gmail.js, so the rest of the system can use either one.
const { supabase, must } = require('../db');
const { withJob } = require('../lock');
const { encrypt, decrypt } = require('./crypto');
const { refresh, MailAuthError } = require('./oauth');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fetchImpl = (...a) => fetch(...a);            // the tests swap this for a fake
const setFetch = f => { fetchImpl = f; };

async function loadAccount() {
  const row = must(await supabase.from('mail_accounts').select('*').eq('provider', 'graph').limit(1))[0];
  if (!row) throw new MailAuthError('No Microsoft mailbox is connected yet');
  return row;
}
const stillGood = row => row.access_token_encrypted && row.access_expires_at && new Date(row.access_expires_at).getTime() - Date.now() > 3 * 60 * 1000;

async function markNeedsReconnect(message) {
  try { must(await supabase.from('mail_accounts').update({ status: 'needs_reconnect', last_error: String(message).slice(0, 300) }).eq('provider', 'graph')); }
  catch (e) { console.error('mail: could not mark the mailbox as needing a reconnect:', e.message); }
}

async function saveTokens(row, t) {
  must(await supabase.from('mail_accounts').update({
    // Microsoft hands out a fresh refresh token each time: always keep the newest one.
    refresh_token_encrypted: t.refresh_token ? encrypt(t.refresh_token) : row.refresh_token_encrypted,
    access_token_encrypted: encrypt(t.access_token),
    access_expires_at: new Date(Date.now() + Number(t.expires_in || 3600) * 1000).toISOString(),
    status: 'connected', last_ok_at: new Date().toISOString(), last_error: null
  }).eq('id', row.id));
}

// A valid access token, refreshing it (one run at a time) when it is about to expire.
async function accessToken() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await loadAccount();
    if (row.status === 'needs_reconnect') throw new MailAuthError('The Microsoft mailbox needs to be reconnected');
    if (stillGood(row)) return decrypt(row.access_token_encrypted);
    const r = await withJob('mail_refresh', 30, async () => {
      const fresh = await loadAccount();
      if (stillGood(fresh)) return { refreshed: false };          // another run refreshed while we waited
      try { await saveTokens(fresh, await refresh(decrypt(fresh.refresh_token_encrypted))); }
      catch (e) {
        if (e instanceof MailAuthError && ['invalid_grant', 'interaction_required', 'consent_required'].includes(e.code)) await markNeedsReconnect(e.message);
        throw e;
      }
      return { refreshed: true };
    });
    if (r && r.skipped) await sleep(1500);
  }
  throw new Error('Could not get a Microsoft access token');
}

async function dropCachedToken() {
  try { must(await supabase.from('mail_accounts').update({ access_expires_at: null }).eq('provider', 'graph')); } catch { /* best effort */ }
}

// prefer: extra Prefer values. "ImmutableId" keeps a message's id the same when it moves between folders.
async function graph(path, { method = 'GET', body, prefer = [] } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken();
    const res = await fetchImpl(`${GRAPH}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: ['IdType="ImmutableId"', ...prefer].join(', ') },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 401) {
      if (attempt === 0) { await dropCachedToken(); continue; }          // maybe just an old token: refresh once and retry
      await markNeedsReconnect('Microsoft rejected the sign-in (401)');
      throw new MailAuthError('Microsoft rejected the sign-in (401)');
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(`Microsoft Graph ${res.status}: ${(j.error && j.error.message) || ''}`.slice(0, 300));   // the next run retries
    }
    return res.status === 202 || res.status === 204 ? null : res.json();
  }
}

const qs = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const recipients = list => (Array.isArray(list) ? list : String(list || '').split(',')).map(s => s.trim()).filter(Boolean).map(address => ({ emailAddress: { address } }));
function parseAddress(s) {
  const m = String(s).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { emailAddress: { address: m[2].trim(), ...(m[1].trim() ? { name: m[1].trim() } : {}) } } : { emailAddress: { address: String(s).trim() } };
}
const bodyOf = (text, html) => ({ contentType: html ? 'HTML' : 'Text', content: html || text || '' });

// Creates a draft and sends it, so we learn the message's ids (needed to match the customer's reply later).
async function sendMail({ to, cc, subject, text, html, replyTo }) {
  const draft = await graph('/me/messages', { method: 'POST', body: {
    subject, body: bodyOf(text, html), toRecipients: recipients(to), ccRecipients: recipients(cc), ...(replyTo ? { replyTo: [parseAddress(replyTo)] } : {})
  } });
  await graph(`/me/messages/${encodeURIComponent(draft.id)}/send`, { method: 'POST' });
  return { messageId: draft.internetMessageId || null, graphMessageId: draft.id, conversationId: draft.conversationId || null };
}

// A reply inside the same thread (Graph does not let us set In-Reply-To by hand, so we use its reply call).
async function sendReply({ graphMessageId, text, html }) {
  const draft = await graph(`/me/messages/${encodeURIComponent(graphMessageId)}/createReply`, { method: 'POST' });
  await graph(`/me/messages/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body: { body: bodyOf(text, html) } });
  await graph(`/me/messages/${encodeURIComponent(draft.id)}/send`, { method: 'POST' });
  return { messageId: draft.internetMessageId || null, graphMessageId: draft.id, conversationId: draft.conversationId || null };
}

function shape(m) {
  const h = {};
  for (const x of m.internetMessageHeaders || []) h[String(x.name).toLowerCase()] = x.value;
  const addr = r => String((r && r.emailAddress && r.emailAddress.address) || '').toLowerCase();
  return {
    uid: m.id, graphMessageId: m.id, conversationId: m.conversationId || null,
    messageId: m.internetMessageId || null, inReplyTo: h['in-reply-to'] || null, references: String(h.references || '').split(/\s+/).filter(Boolean),
    from: { address: addr(m.from), name: (m.from && m.from.emailAddress && m.from.emailAddress.name) || '' },
    to: [...(m.toRecipients || []).map(addr), ...(m.ccRecipients || []).map(addr), ...String(h['delivered-to'] || '').split(/[\s,]+/), ...String(h['x-original-to'] || '').split(/[\s,]+/)]
      .map(s => s.toLowerCase()).filter(s => s.includes('@')),
    subject: m.subject || '', text: String((m.body && m.body.content) || '').trim(), date: m.receivedDateTime || new Date().toISOString(),
    hasAttachments: !!m.hasAttachments,
    headers: { autoSubmitted: h['auto-submitted'] || '', precedence: h.precedence || '', xAutoreply: h['x-autoreply'] || h['x-autorespond'] || '' }
  };
}

// Unread inbox mail from the last few days, newest first.
async function fetchUnread({ sinceDays = 5, max = 15 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const q = qs({
    $filter: `receivedDateTime ge ${since} and isRead eq false`, $orderby: 'receivedDateTime desc', $top: String(max),
    $select: 'id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,internetMessageHeaders'
  });
  const j = await graph(`/me/mailFolders/inbox/messages?${q}`, { prefer: ['outlook.body-content-type="text"'] });
  return ((j && j.value) || []).map(shape);
}

async function markSeen(ids) {
  for (const id of ids) await graph(`/me/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: { isRead: true } });
}

async function mailboxAddress() { return (await loadAccount()).address; }

module.exports = { setFetch, sendMail, sendReply, fetchUnread, markSeen, mailboxAddress, loadAccount, shape };
