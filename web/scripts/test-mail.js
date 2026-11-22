// node scripts/test-mail.js  — checks the Microsoft mailbox code with FAKE Microsoft answers and a stand-in database.
// Nothing real is contacted: no Microsoft, no Supabase, no email.
process.env.MAIL_TOKEN_KEY = '0123456789abcdef'.repeat(4);
process.env.MS_CLIENT_ID = 'client-id-123';
process.env.MS_CLIENT_SECRET = 'secret-xyz';
process.env.APP_DOMAIN = 'invoice-chaser-alpha.vercel.app';
process.env.OWNER_EMAIL = 'owner@acme.example';
delete process.env.MAIL_EXPECTED_ADDRESS;

const assert = require('assert');
const eq = assert.deepStrictEqual;

// ---- stand-in database (same idea as test-disputes.js) ----
let TABLES = {};
function from(name) {
  let op = 'select', filters = [], payload = null, one = false, after = false;
  const api = {
    select() { after = true; return api; },
    insert(p) { op = 'insert'; payload = p; return api; },
    update(p) { op = 'update'; payload = p; return api; },
    eq(c, v) { filters.push(r => r[c] === v); return api; },
    limit() { return api; },
    single() { one = true; return api; },
    maybeSingle() { one = true; return api; },
    then(resolve, reject) {
      const rows = TABLES[name] = TABLES[name] || [];
      const hit = rows.filter(r => filters.every(f => f(r)));
      let data;
      if (op === 'insert') { const row = { id: `${name}-${rows.length + 1}`, ...payload }; rows.push(row); data = after ? (one ? row : [row]) : null; }
      else if (op === 'update') { hit.forEach(r => Object.assign(r, payload)); data = after ? (one ? hit[0] : hit) : null; }
      else data = one ? hit[0] || null : hit;
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    }
  };
  return api;
}
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const inject = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
inject('../lib/db', { supabase: { from }, must, fetchAll: async () => [], logEvent: async () => {} });
inject('../lib/lock', { withJob: async (name, ttl, fn) => fn() });
inject('../lib/auth', { isCronAuthorized: req => (req.query || {}).secret === 'test-secret' });

const C = require('../lib/mail/crypto');
const O = require('../lib/mail/oauth');
const G = require('../lib/mail/graph');
const route = require('../api/mail/[action]');

// ---- fake Microsoft ----
let CALLS = [], HANDLERS = [];
const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (json === undefined) throw new Error('no body'); return json; } });
const fakeFetch = async (url, opts = {}) => {
  CALLS.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
  const h = HANDLERS.find(x => x.match(String(url), opts));
  return h ? h.respond(String(url), opts) : reply(404, { error: { message: 'no fake handler' } });
};
O.setFetch(fakeFetch); G.setFetch(fakeFetch);
const tokenHandler = (respond) => ({ match: u => u.includes('/oauth2/v2.0/token'), respond });
const jwt = claims => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const seed = (o = {}) => { TABLES = { mail_accounts: [{ id: 'm1', provider: 'graph', address: 'tiagvjbn@outlook.com', status: 'connected', refresh_token_encrypted: C.encrypt('RT1'), access_token_encrypted: C.encrypt('AT1'), access_expires_at: new Date(Date.now() + 3600e3).toISOString(), ...o }] }; CALLS = []; HANDLERS = []; };
const fakeRes = () => { const r = { headers: {}, statusCode: 200, body: null, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.statusCode = c; return r; }, json(o) { r.body = o; return r; }, send(s) { r.body = s; return r; }, writeHead(c, h) { r.statusCode = c; Object.assign(r.headers, h); }, end(s) { if (s) r.body = s; } }; return r; };
const call = async (req) => { const res = fakeRes(); await route({ method: 'GET', headers: {}, query: {}, ...req }, res); return res; };

let passed = 0; const failures = [], tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- protecting the tokens ----------
test('crypto: a token round-trips, is never stored as plain text, and a different key cannot read it', () => {
  const blob = C.encrypt('my-refresh-token');
  assert(!blob.includes('my-refresh-token')); eq(C.decrypt(blob), 'my-refresh-token'); assert(C.encrypt('x') !== C.encrypt('x'));
  const old = process.env.MAIL_TOKEN_KEY; process.env.MAIL_TOKEN_KEY = 'f'.repeat(64);
  assert.throws(() => C.decrypt(blob)); process.env.MAIL_TOKEN_KEY = old;
  assert.throws(() => C.decrypt(blob.slice(0, -4) + 'AAAA'));
});
test('crypto: a bad or missing key is refused with a plain message', () => {
  const old = process.env.MAIL_TOKEN_KEY;
  process.env.MAIL_TOKEN_KEY = 'short'; assert.throws(() => C.encrypt('x'), /64 hex/);
  delete process.env.MAIL_TOKEN_KEY; assert.throws(() => C.encrypt('x'), /64 hex/); process.env.MAIL_TOKEN_KEY = old;
});
test('crypto: the sign-in cookie value is signed, expires, and cannot be forged', () => {
  const v = C.signValue({ s: 'abc', v: 'ver' });
  eq([C.verifyValue(v).s, C.verifyValue(v).v], ['abc', 'ver']);
  eq(C.verifyValue(v.slice(0, -2) + 'xx'), null); eq(C.verifyValue(C.signValue({ s: 'abc' }, -1)), null); eq(C.verifyValue('garbage'), null); eq(C.verifyValue(''), null);
  const [body] = v.split('.'); eq(C.verifyValue(`${Buffer.from('{"s":"evil","exp":9999999999999}').toString('base64url')}.${v.split('.')[1]}`), null); assert(body);
});

// ---------- signing in ----------
test('oauth: PKCE matches the official example, and the sign-in address has everything Microsoft needs', () => {
  eq(O.challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const p = O.pkcePair(); assert(p.verifier.length >= 43); eq(O.challengeFor(p.verifier), p.challenge);
  const u = new URL(O.authorizeUrl({ state: 'st8', challenge: p.challenge }));
  eq(u.origin + u.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  eq([u.searchParams.get('client_id'), u.searchParams.get('response_type'), u.searchParams.get('code_challenge_method'), u.searchParams.get('state')], ['client-id-123', 'code', 'S256', 'st8']);
  eq(u.searchParams.get('redirect_uri'), 'https://invoice-chaser-alpha.vercel.app/api/mail/callback');
  const sc = u.searchParams.get('scope'); for (const s of ['offline_access', 'Mail.ReadWrite', 'Mail.Send', 'User.Read']) assert(sc.includes(s), s);
  assert(!sc.includes('Mail.Send.Shared') && !sc.includes('.All'));
});
test('oauth: the code is exchanged with the PKCE verifier, and Microsoft errors become plain messages', async () => {
  seed(); HANDLERS = [tokenHandler(() => reply(200, { access_token: 'A', refresh_token: 'R', expires_in: 3600 }))];
  await O.exchangeCode('thecode', 'theverifier');
  const b = new URLSearchParams(CALLS[0].body);
  eq([b.get('grant_type'), b.get('code'), b.get('code_verifier'), b.get('client_secret')], ['authorization_code', 'thecode', 'theverifier', 'secret-xyz']);
  HANDLERS = [tokenHandler(() => reply(400, { error: 'invalid_grant', error_description: 'The refresh token has expired.\r\nTrace ID: 1' }))];
  await assert.rejects(() => O.refresh('old'), e => e instanceof O.MailAuthError && e.code === 'invalid_grant' && !e.message.includes('Trace'));
});

// ---------- the connect pages ----------
test('route: connect needs the secret, and starts a signed, same-site sign-in', async () => {
  seed(); eq((await call({ query: { action: 'connect' } })).statusCode, 401);
  const r = await call({ query: { action: 'connect', secret: 'test-secret' } });
  eq(r.statusCode, 302); assert(r.headers.Location.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?'));
  const ck = r.headers['Set-Cookie']; assert(ck.startsWith('mail_oauth=') && ck.includes('HttpOnly') && ck.includes('Secure') && ck.includes('SameSite=Lax') && ck.includes('Path=/api/mail'));
  const saved = C.verifyValue(ck.split(';')[0].replace('mail_oauth=', '')); eq(new URL(r.headers.Location).searchParams.get('state'), saved.s);
});
test('route: connect names any missing setting instead of failing quietly', async () => {
  const old = process.env.MS_CLIENT_ID; delete process.env.MS_CLIENT_ID;
  const r = await call({ query: { action: 'connect', secret: 'test-secret' } }); process.env.MS_CLIENT_ID = old;
  eq(r.statusCode, 500); assert(r.body.includes('MS_CLIENT_ID'));
});
const startSignIn = async () => { const r = await call({ query: { action: 'connect', secret: 'test-secret' } }); return { cookie: r.headers['Set-Cookie'].split(';')[0], state: new URL(r.headers.Location).searchParams.get('state') }; };
const okMicrosoft = (mail = 'TiagVjbn@outlook.com', scope = 'openid Mail.ReadWrite Mail.Send User.Read') => [
  tokenHandler(() => reply(200, { access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 3600, scope, id_token: jwt({ tid: 'tenant-1' }) })),
  { match: u => u.includes('/v1.0/me?'), respond: () => reply(200, { mail, userPrincipalName: mail, displayName: 'T' }) }
];
test('route: a good sign-in saves the mailbox with encrypted tokens', async () => {
  seed(); TABLES.mail_accounts = []; const s = await startSignIn(); HANDLERS = okMicrosoft();
  const r = await call({ query: { action: 'callback', code: 'c0de', state: s.state }, headers: { cookie: s.cookie } });
  eq(r.statusCode, 200); assert(r.body.includes('tiagvjbn@outlook.com'));
  const row = TABLES.mail_accounts[0];
  eq([row.address, row.tenant_id, row.status], ['tiagvjbn@outlook.com', 'tenant-1', 'connected']);
  eq([C.decrypt(row.refresh_token_encrypted), C.decrypt(row.access_token_encrypted)], ['RT-new', 'AT-new']);
  assert(!JSON.stringify(row).includes('RT-new') && !JSON.stringify(row).includes('AT-new'));
});
test('route: a forged, missing, expired or mismatched sign-in is refused and saves nothing', async () => {
  seed(); TABLES.mail_accounts = []; const s = await startSignIn(); HANDLERS = okMicrosoft();
  eq((await call({ query: { action: 'callback', code: 'c', state: s.state } })).statusCode, 400);                                           // no cookie
  eq((await call({ query: { action: 'callback', code: 'c', state: 'other' }, headers: { cookie: s.cookie } })).statusCode, 400);           // wrong state
  eq((await call({ query: { action: 'callback', code: 'c', state: s.state }, headers: { cookie: `mail_oauth=${C.signValue({ s: s.state, v: 'v' }, -1)}` } })).statusCode, 400);   // expired
  const e = await call({ query: { action: 'callback', error: 'access_denied', error_description: '<script>x</script>' } });
  eq(e.statusCode, 400); assert(!e.body.includes('<script>x</script>'));
  eq(TABLES.mail_accounts.length, 0); eq(CALLS.length, 0);
});
test('route: the wrong mailbox, or missing permissions, are refused', async () => {
  seed(); TABLES.mail_accounts = []; process.env.MAIL_EXPECTED_ADDRESS = 'someone.else@outlook.com';
  let s = await startSignIn(); HANDLERS = okMicrosoft();
  let r = await call({ query: { action: 'callback', code: 'c', state: s.state }, headers: { cookie: s.cookie } });
  eq(r.statusCode, 400); assert(r.body.includes('not the mailbox we expected')); delete process.env.MAIL_EXPECTED_ADDRESS; eq(TABLES.mail_accounts.length, 0);
  s = await startSignIn(); HANDLERS = okMicrosoft('a@b.com', 'openid User.Read');
  r = await call({ query: { action: 'callback', code: 'c', state: s.state }, headers: { cookie: s.cookie } });
  eq(r.statusCode, 400); eq(TABLES.mail_accounts.length, 0);
});
test('route: status never shows a token, and needs the secret', async () => {
  seed(); eq((await call({ query: { action: 'status' } })).statusCode, 401);
  const r = await call({ query: { action: 'status', secret: 'test-secret' } }); const text = JSON.stringify(r.body);
  eq([r.body.connected, r.body.address], [true, 'tiagvjbn@outlook.com']);
  const row = TABLES.mail_accounts[0]; assert(!/token_encrypted|AT1|RT1|v1:/.test(text) && !text.includes(row.refresh_token_encrypted) && !text.includes(row.access_token_encrypted));
  TABLES.mail_accounts = []; eq((await call({ query: { action: 'status', secret: 'test-secret' } })).body.status, 'not_connected');
});

// ---------- the mail itself ----------
const graphOk = (match, json, status = 200) => ({ match, respond: () => reply(status, json) });
test('graph: an old token is refreshed once, the newest refresh token is kept, and the next call reuses it', async () => {
  seed({ access_expires_at: new Date(Date.now() - 1000).toISOString() });
  HANDLERS = [tokenHandler(() => reply(200, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 })), graphOk(u => u.includes('/mailFolders/inbox'), { value: [] })];
  await G.fetchUnread(); await G.fetchUnread();
  eq(CALLS.filter(c => c.url.includes('/token')).length, 1);
  const b = new URLSearchParams(CALLS.find(c => c.url.includes('/token')).body); eq([b.get('grant_type'), b.get('refresh_token')], ['refresh_token', 'RT1']);
  const row = TABLES.mail_accounts[0]; eq([C.decrypt(row.refresh_token_encrypted), C.decrypt(row.access_token_encrypted)], ['RT2', 'AT2']);
  eq(CALLS.filter(c => c.url.includes('graph.microsoft.com'))[0].headers.Authorization, 'Bearer AT2');
});
test('graph: when Microsoft says the sign-in is gone, the mailbox is marked "needs reconnect" and stops trying', async () => {
  seed({ access_expires_at: null }); HANDLERS = [tokenHandler(() => reply(400, { error: 'invalid_grant', error_description: 'expired' }))];
  await assert.rejects(() => G.fetchUnread(), e => e instanceof O.MailAuthError);
  eq(TABLES.mail_accounts[0].status, 'needs_reconnect'); const n = CALLS.length;
  await assert.rejects(() => G.sendMail({ to: 'a@b.com', subject: 's', text: 't' }), /reconnected/); eq(CALLS.length, n);
});
test('graph: one 401 is retried with a fresh token; a second 401 means "needs reconnect"', async () => {
  seed(); let n = 0;
  HANDLERS = [tokenHandler(() => reply(200, { access_token: 'AT-fresh', refresh_token: 'RT-fresh', expires_in: 3600 })), { match: u => u.includes('/mailFolders/inbox'), respond: () => (++n === 1 ? reply(401, {}) : reply(200, { value: [] })) }];
  eq(await G.fetchUnread(), []); eq(CALLS.filter(c => c.url.includes('/token')).length, 1);
  seed(); HANDLERS = [tokenHandler(() => reply(200, { access_token: 'x', refresh_token: 'y', expires_in: 3600 })), { match: u => u.includes('/mailFolders/inbox'), respond: () => reply(401, {}) }];
  await assert.rejects(() => G.fetchUnread(), O.MailAuthError); eq(TABLES.mail_accounts[0].status, 'needs_reconnect');
});
test('graph: unread mail is asked for the safe way and comes back in the same shape as the Gmail code', async () => {
  seed();
  HANDLERS = [graphOk(u => u.includes('/mailFolders/inbox'), { value: [{
    id: 'AAMk1', internetMessageId: '<abc@mail>', conversationId: 'conv1', subject: 'Re: Invoice INV-5003',
    from: { emailAddress: { name: 'Sam', address: 'Billing@Brindley-Test.Example' } }, toRecipients: [{ emailAddress: { address: 'Tiagvjbn+a1b2c3d4e5@outlook.com' } }], ccRecipients: [],
    receivedDateTime: '2026-11-22T10:00:00Z', body: { contentType: 'text', content: '  We will pay on Friday.  ' }, hasAttachments: false,
    internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }, { name: 'References', value: '<a@x> <b@y>' }, { name: 'In-Reply-To', value: '<b@y>' }]
  }] })];
  const [m] = await G.fetchUnread({ sinceDays: 5, max: 15 });
  const call0 = CALLS.find(c => c.url.includes('/mailFolders/inbox')); const url = decodeURIComponent(call0.url);
  assert(url.includes('$filter=receivedDateTime ge ') && url.includes(' and isRead eq false') && url.includes('$orderby=receivedDateTime desc') && url.includes('$top=15') && url.includes('internetMessageHeaders'));
  assert(call0.headers.Prefer.includes('IdType="ImmutableId"') && call0.headers.Prefer.includes('outlook.body-content-type="text"'));
  eq([m.uid, m.graphMessageId, m.conversationId, m.messageId, m.inReplyTo, m.references], ['AAMk1', 'AAMk1', 'conv1', '<abc@mail>', '<b@y>', ['<a@x>', '<b@y>']]);
  eq([m.from, m.to, m.subject, m.text, m.date], [{ address: 'billing@brindley-test.example', name: 'Sam' }, ['tiagvjbn+a1b2c3d4e5@outlook.com'], 'Re: Invoice INV-5003', 'We will pay on Friday.', '2026-11-22T10:00:00Z']);
  eq(m.headers, { autoSubmitted: 'auto-replied', precedence: '', xAutoreply: '' });
});
test('graph: sending makes a draft, sends it, and returns the ids we need to match the reply later', async () => {
  seed();
  HANDLERS = [graphOk(u => u.endsWith('/me/messages'), { id: 'D1', internetMessageId: '<m1@x>', conversationId: 'conv9' }), { match: u => u.endsWith('/send'), respond: () => reply(202) }];
  const r = await G.sendMail({ to: 'a@b.com, c@d.com', cc: ['e@f.com'], subject: 'Hello', text: 'plain', html: '<p>rich</p>', replyTo: '"Acme Accounts" <chaser+abc123@outlook.com>' });
  eq(r, { messageId: '<m1@x>', graphMessageId: 'D1', conversationId: 'conv9' });
  const draft = JSON.parse(CALLS.find(c => c.method === 'POST' && c.url.endsWith('/me/messages')).body);
  eq([draft.subject, draft.body, draft.toRecipients.map(x => x.emailAddress.address), draft.ccRecipients.map(x => x.emailAddress.address)], ['Hello', { contentType: 'HTML', content: '<p>rich</p>' }, ['a@b.com', 'c@d.com'], ['e@f.com']]);
  eq(draft.replyTo, [{ emailAddress: { address: 'chaser+abc123@outlook.com', name: 'Acme Accounts' } }]);
  assert(CALLS.some(c => c.url.endsWith('/me/messages/D1/send') && c.method === 'POST'));
  seed(); HANDLERS = [graphOk(u => u.endsWith('/me/messages'), { id: 'D2' }), { match: u => u.endsWith('/send'), respond: () => reply(202) }];
  await G.sendMail({ to: 'a@b.com', subject: 's', text: 'only text' }); eq(JSON.parse(CALLS.find(c => c.url.endsWith('/me/messages')).body).body, { contentType: 'Text', content: 'only text' });
});
test('graph: a reply is made inside the original thread, then its text is set and it is sent', async () => {
  seed();
  HANDLERS = [graphOk(u => u.endsWith('/createReply'), { id: 'R1', conversationId: 'conv1' }), { match: (u, o) => o.method === 'PATCH', respond: () => reply(200, {}) }, { match: u => u.endsWith('/send'), respond: () => reply(202) }];
  await G.sendReply({ graphMessageId: 'AAMk=/1', text: 'Thanks, noted.', html: '<p>Thanks, noted.</p>' });
  eq(CALLS.filter(c => c.url.includes('graph.microsoft.com')).map(c => `${c.method} ${c.url.replace('https://graph.microsoft.com/v1.0', '')}`), ['POST /me/messages/AAMk%3D%2F1/createReply', 'PATCH /me/messages/R1', 'POST /me/messages/R1/send']);
  eq(JSON.parse(CALLS.find(c => c.method === 'PATCH').body), { body: { contentType: 'HTML', content: '<p>Thanks, noted.</p>' } });
});
test('graph: marking mail as read changes only the read flag', async () => {
  seed(); HANDLERS = [{ match: (u, o) => o.method === 'PATCH', respond: () => reply(200, {}) }];
  await G.markSeen(['id1', 'id=2']); const p = CALLS.filter(c => c.method === 'PATCH');
  eq(p.map(c => c.url.replace('https://graph.microsoft.com/v1.0', '')), ['/me/messages/id1', '/me/messages/id%3D2']); eq(p.map(c => JSON.parse(c.body)), [{ isRead: true }, { isRead: true }]);
});
test('graph: a Microsoft server error is reported, not swallowed (the next run retries)', async () => {
  seed(); HANDLERS = [graphOk(u => u.includes('/mailFolders/inbox'), { error: { message: 'busy' } }, 503)];
  await assert.rejects(() => G.fetchUnread(), /Graph 503/); eq(TABLES.mail_accounts[0].status, 'connected');
});

// ---------- the test page can never email a customer ----------
test('route: the test email only goes to the connected mailbox or the owner', async () => {
  seed(); HANDLERS = [graphOk(u => u.endsWith('/me/messages'), { id: 'D1', internetMessageId: '<m@x>', conversationId: 'c1' }), { match: u => u.endsWith('/send'), respond: () => reply(202) }, graphOk(u => u.includes('/mailFolders/inbox'), { value: [] })];
  const bad = await call({ query: { action: 'test', secret: 'test-secret', to: 'customer@brindley.example' } }); eq(bad.statusCode, 400); eq(CALLS.length, 0);
  const own = await call({ query: { action: 'test', secret: 'test-secret' } });
  eq([own.statusCode, own.body.ok, own.body.sent], [200, true, { to: 'tiagvjbn@outlook.com', hasMessageId: true, hasConversationId: true }]);
  const owner = await call({ query: { action: 'test', secret: 'test-secret', to: 'OWNER@acme.example' } }); eq(owner.body.sent.to, 'owner@acme.example');
  CALLS = []; const readOnly = await call({ query: { action: 'test', secret: 'test-secret', send: '0' } }); eq([readOnly.body.sent, CALLS.some(c => c.method === 'POST')], [null, false]);
  eq((await call({ query: { action: 'test' } })).statusCode, 401);
});
test('route: a mailbox that needs reconnecting is reported with a plain hint', async () => {
  seed({ status: 'needs_reconnect' }); const r = await call({ query: { action: 'test', secret: 'test-secret', send: '0' } });
  eq(r.statusCode, 401); assert(r.body.hint.includes('/api/mail/connect'));
});

(async () => {
  for (const [name, fn] of tests) { try { await fn(); passed++; } catch (e) { failures.push(`✗ ${name}\n    ${String(e.message).split('\n').slice(0, 6).join('\n    ')}`); } }
  console.log(failures.length ? failures.join('\n') : '');
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();