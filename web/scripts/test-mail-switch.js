// node scripts/test-mail-switch.js  — checks S1 part B: the Gmail/Outlook switch, sending, finding the customer from the
// email thread, and the whole reply pipeline for BOTH providers. Fake mail servers and a stand-in database:
// nothing real is contacted and nothing is sent.
const assert = require('assert');
const eq = assert.deepStrictEqual;

// ---- stand-in database ----
let TABLES = {}, NOWMS = Date.now();
function from(name) {
  let op = 'select', filters = [], payload = null, one = false, after = false, orderBy = null, lim = null;
  const api = {
    select() { after = true; return api; },
    insert(p) { op = 'insert'; payload = p; return api; },
    update(p) { op = 'update'; payload = p; return api; },
    eq(c, v) { filters.push(r => r[c] === v); return api; },
    neq(c, v) { filters.push(r => r[c] !== v); return api; },
    in(c, vs) { filters.push(r => vs.includes(r[c])); return api; },
    contains(c, vs) { filters.push(r => Array.isArray(r[c]) && vs.every(v => r[c].includes(v))); return api; },
    ilike(c, pat) { const re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); filters.push(r => re.test(String(r[c] || ''))); return api; },
    gte(c, v) { filters.push(r => String(r[c] || '') >= v); return api; },
    order(c, o) { orderBy = [c, !(o && o.ascending === false)]; return api; },
    limit(n) { lim = n; return api; }, range() { return api; },
    single() { one = true; return api; }, maybeSingle() { one = true; return api; },
    then(resolve, reject) {
      const rows = TABLES[name] = TABLES[name] || [];
      let hit = rows.filter(r => filters.every(f => f(r)));
      if (orderBy) hit = [...hit].sort((a, b) => (String(a[orderBy[0]] || '') < String(b[orderBy[0]] || '') ? -1 : 1) * (orderBy[1] ? 1 : -1));
      if (lim) hit = hit.slice(0, lim);
      let out;
      if (op === 'insert') { const row = { id: `${name}-${rows.length + 1}`, created_at: new Date().toISOString(), status: name === 'tasks' ? 'open' : undefined, ...payload }; rows.push(row); out = { data: after ? (one ? row : [row]) : null, error: null }; }
      else if (op === 'update') { hit.forEach(r => Object.assign(r, payload)); out = { data: after ? hit : null, error: null }; }
      else out = { data: one ? hit[0] || null : hit, error: null };
      return Promise.resolve(out).then(resolve, reject);
    }
  };
  return api;
}
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const inject = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };

// ---- fake mail servers and other neighbours ----
let ALERTS = [], GM = [], GR = [], GMAIL_INBOX = [], GRAPH_INBOX = [], GRAPH_FAIL = null, GMAIL_FAIL = null, CLS = null, CLS_FAIL = null;
const gmailFake = {
  sendMail: async o => { if (GMAIL_FAIL) throw GMAIL_FAIL; GM.push(['sendMail', o]); return { messageId: '<gm-out@x>' }; },
  fetchUnread: async () => GMAIL_INBOX, markSeen: async ids => { GM.push(['markSeen', ids]); }
};
const O = require('../lib/mail/oauth');
const graphFake = {
  sendMail: async o => { if (GRAPH_FAIL) throw GRAPH_FAIL; GR.push(['sendMail', o]); return { messageId: '<g-out@x>', graphMessageId: 'GID-OUT', conversationId: 'CONV-OUT' }; },
  sendReply: async o => { if (GRAPH_FAIL) throw GRAPH_FAIL; GR.push(['sendReply', o]); return { messageId: '<g-reply@x>', graphMessageId: 'GID-REPLY', conversationId: 'CONV1' }; },
  fetchUnread: async () => { if (GRAPH_FAIL) throw GRAPH_FAIL; return GRAPH_INBOX; }, markSeen: async ids => { GR.push(['markSeen', ids]); },
  mailboxAddress: async () => { GR.push(['mailboxAddress']); return 'TiagVjbn@outlook.com'; }
};
inject('../lib/db', { supabase: { from }, must, fetchAll: async b => must(await b()), logEvent: async () => {} });
inject('../lib/notify', { alertOwner: async a => { ALERTS.push(a); return { sent: true }; } });
inject('../lib/sms', { sendSms: async () => ({ sid: 'x' }) });
inject('../lib/replytext', { stripQuoted: t => String(t || '').trim(), isAutoReply: ({ headers = {} }) => /auto/i.test(headers.autoSubmitted || ''), isBounce: () => false, extractEmails: () => [], cleanSubject: s => String(s || '').replace(/^(re|fwd?):\s*/gi, '') });
inject('../lib/classify', { safetyScan: () => null, classifyReply: async ({ replyText }) => { if (CLS_FAIL && replyText.includes(CLS_FAIL)) throw new Error('the AI is down'); return CLS; } });
inject('../lib/gmail', gmailFake);
inject('../lib/mail/graph', graphFake);

const mail = require('../lib/mail');
const { getConfig } = require('../lib/config');
const { sendCustomerEmail, sendOwnerEmail } = require('../lib/outbound');
const { matchInbound, tokenFrom } = require('../lib/match');
const { pollInbox } = require('../lib/inbox');
const D = require('../lib/dates');

const ENV_KEYS = ['MAIL_PROVIDER', 'MAIL_PLUS_ADDRESSING', 'GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD', 'DRY_RUN', 'TEST_EMAIL_OVERRIDE', 'OWNER_EMAIL', 'BUSINESS_NAME'];
function setup({ provider = 'gmail', env = {}, backup = false } = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { DRY_RUN: 'false', TEST_EMAIL_OVERRIDE: 'owner@acme.example', OWNER_EMAIL: 'owner@acme.example', BUSINESS_NAME: 'Acme', GMAIL_ADDRESS: 'chaser@gmail.com', MAIL_PROVIDER: provider }, backup ? { GMAIL_APP_PASSWORD: 'x' } : {}, env);
  mail.forgetMailbox(); ALERTS = []; GM = []; GR = []; GMAIL_INBOX = []; GRAPH_INBOX = []; GRAPH_FAIL = null; GMAIL_FAIL = null; CLS_FAIL = null;
  const soon = D.addDays(D.todayISO('Europe/London'), 3);
  CLS = { intent: 'promise_to_pay', confidence: 0.95, sentiment: 'neutral', promised_date: soon, partial_amount: null, summary: 'will pay', suggested_reply: null };
  const old = new Date(Date.now() - 2 * 86400000).toISOString();
  TABLES = {
    customers: [
      { id: 'c1', name: 'Brindley Construction Ltd', contact_name: 'Sam', email: 'billing@brindley-test.example', extra_emails: [], reply_token: 'tok123abc', do_not_contact: false },
      { id: 'c2', name: 'Dunmore Logistics Ltd', contact_name: 'Dee', email: 'd@dunmore-test.example', extra_emails: [], reply_token: 'tok999xyz', do_not_contact: false }
    ],
    invoices: [
      { id: 'i1', customer_id: 'c1', invoice_number: 'INV-5003', amount_cents: 900000, amount_paid_cents: 0, currency: 'GBP', status: 'open', due_date: '2026-10-07', promised_count: 0, invoice_url: null },
      { id: 'i2', customer_id: 'c2', invoice_number: 'INV-5005', amount_cents: 320000, amount_paid_cents: 0, currency: 'GBP', status: 'open', due_date: '2026-11-06', promised_count: 0, invoice_url: null }
    ],
    outbound_messages: [
      { id: 'o1', customer_id: 'c1', kind: 'reminder', status: 'sent', invoice_ids: ['i1'], message_id: '<rem1@x>', conversation_id: 'CONV1', created_at: old },
      { id: 'o2', customer_id: null, kind: 'owner_alert', status: 'sent', message_id: '<alert@x>', conversation_id: 'CONV-ALERT', created_at: old }
    ],
    inbound_messages: [], tasks: [], routing_rules: []
  };
}
const customer = () => TABLES.customers[0];
const graphMsg = (o = {}) => ({ uid: 'GID-IN', graphMessageId: 'GID-IN', conversationId: 'CONV1', messageId: '<in1@mail>', inReplyTo: '<rem1@x>', references: ['<rem1@x>'], from: { address: 'hubert@gmail.com', name: 'Hubert' }, to: ['tiagvjbn@outlook.com'], subject: 'Re: Invoice INV-5003', text: 'We will pay on Friday.', date: new Date().toISOString(), headers: { autoSubmitted: '' }, ...o });

let passed = 0; const failures = [], tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- the switch ----------
test('switch: Gmail is the default, Microsoft only when asked, and a typo falls back to Gmail', () => {
  setup(); eq(mail.provider(), 'gmail');
  process.env.MAIL_PROVIDER = 'graph'; eq(mail.provider(), 'graph'); process.env.MAIL_PROVIDER = ' GRAPH '; eq(mail.provider(), 'graph');
  process.env.MAIL_PROVIDER = 'outlook'; eq(mail.provider(), 'gmail'); delete process.env.MAIL_PROVIDER; eq(mail.provider(), 'gmail');
});
test('switch: Reply-To plus-addresses are on for Gmail, off for Microsoft, and can be set by hand', () => {
  setup(); eq(mail.plusAddressing(), true);
  setup({ provider: 'graph' }); eq(mail.plusAddressing(), false);
  setup({ provider: 'graph', env: { MAIL_PLUS_ADDRESSING: 'true' } }); eq(mail.plusAddressing(), true);
  setup({ provider: 'gmail', env: { MAIL_PLUS_ADDRESSING: 'off' } }); eq(mail.plusAddressing(), false);
});
test('switch: the mailbox address comes from the right place, lower-case, and is remembered', async () => {
  setup(); eq(await mail.mailboxAddress(), 'chaser@gmail.com');
  setup({ provider: 'graph' }); eq(await mail.mailboxAddress(), 'tiagvjbn@outlook.com'); await mail.mailboxAddress(); eq(GR.filter(c => c[0] === 'mailboxAddress').length, 1);
});
test('switch: a reply is a normal send for Gmail and a thread reply for Microsoft', async () => {
  setup(); await mail.sendReply({ to: 'a@b.com', subject: 's', text: 't', inReplyTo: '<x>' }); eq(GM[0][0], 'sendMail'); eq(GM[0][1].inReplyTo, '<x>');
  setup({ provider: 'graph' }); await mail.sendReply({ graphMessageId: 'G', to: 'a@b.com', text: 't' }); eq(GR[0][0], 'sendReply');
});

// ---------- sending ----------
const send = (extra = {}) => sendCustomerEmail({ cfg: getConfig(), customer: customer(), to: 'billing@brindley-test.example', subject: 'Invoice INV-5003 — a quick reminder', text: 'hi', html: '<p>hi</p>', kind: 'reminder', invoiceIds: ['i1'], ...extra });
const lastLog = () => TABLES.outbound_messages[TABLES.outbound_messages.length - 1];
test('send (Gmail): nothing changes from before: override, plus-address, thread headers, and no Microsoft columns in the log', async () => {
  setup(); eq((await send({ inReplyTo: '<a@x>', references: ['<a@x>'] })).ok, true);
  const [, o] = GM[0];
  eq([o.to, o.subject, o.replyTo, o.inReplyTo, o.references, o.fromName], ['owner@acme.example', '[TEST for billing@brindley-test.example] Invoice INV-5003 — a quick reminder', '"Acme Accounts" <chaser+tok123abc@gmail.com>', '<a@x>', ['<a@x>'], 'Acme Accounts']);
  const row = lastLog(); eq([row.status, row.message_id], ['sent', '<gm-out@x>']); assert(!('graph_message_id' in row) && !('conversation_id' in row)); eq(GR.length, 0);
});
test('send (Microsoft): goes through Outlook, sets no Reply-To, and keeps the ids that match the reply later', async () => {
  setup({ provider: 'graph' }); await send(); const [kind, o] = GR.find(c => c[0] === 'sendMail');
  eq([kind, o.to, o.replyTo], ['sendMail', 'owner@acme.example', undefined]);
  const row = lastLog(); eq([row.status, row.message_id, row.graph_message_id, row.conversation_id], ['sent', '<g-out@x>', 'GID-OUT', 'CONV-OUT']); eq(GM.length, 0);
  setup({ provider: 'graph', env: { MAIL_PLUS_ADDRESSING: 'true' } }); await send(); eq(GR.find(c => c[0] === 'sendMail')[1].replyTo, '"Acme Accounts" <tiagvjbn+tok123abc@outlook.com>');
});
test('send (Microsoft): an acknowledgement is a reply in the same thread, and the test override still decides who gets it', async () => {
  setup({ provider: 'graph' }); await send({ kind: 'ack', to: 'real.customer@brindley-test.example', replyToGraphId: 'GID-IN', subject: 'Re: x' });
  const r = GR.find(c => c[0] === 'sendReply'); assert(r && !GR.some(c => c[0] === 'sendMail'));
  eq([r[1].graphMessageId, r[1].to], ['GID-IN', 'owner@acme.example']);                                    // NOT the real customer
  eq([lastLog().graph_message_id, lastLog().conversation_id, lastLog().kind], ['GID-REPLY', 'CONV1', 'ack']);
  setup({ provider: 'graph', env: { TEST_EMAIL_OVERRIDE: '' } }); await send({ kind: 'ack', to: 'real.customer@brindley-test.example', replyToGraphId: 'GID-IN' });
  eq(GR.find(c => c[0] === 'sendReply')[1].to, 'real.customer@brindley-test.example');
  setup(); await send({ kind: 'ack', replyToGraphId: 'GID-IN' }); eq(GM[0][0], 'sendMail'); eq(GR.length, 0);   // Gmail ignores the Microsoft id
});
test('send: dry run only logs, and a failure is logged and reported', async () => {
  setup({ provider: 'graph', env: { DRY_RUN: 'true' } }); eq((await send()).dryRun, true); eq([GR.length, GM.length, lastLog().status], [0, 0, 'dry_run']);
  setup({ provider: 'graph' }); GRAPH_FAIL = new Error('Microsoft Graph 503'); const r = await send(); eq([r.ok, lastLog().status], [false, 'failed']); assert(lastLog().error.includes('503'));
});
test('owner mail: if Outlook needs reconnecting, a Gmail backup (when set up) still reaches the owner', async () => {
  const owner = () => sendOwnerEmail({ subject: 'Alert', text: 't', html: '<p>t</p>' });
  setup({ provider: 'graph', backup: true }); GRAPH_FAIL = new O.MailAuthError('invalid_grant'); eq((await owner()).backup, 'gmail');
  eq([GM[0][0], GM[0][1].to, lastLog().status], ['sendMail', 'owner@acme.example', 'sent']); assert(lastLog().error.includes('Gmail backup'));
  setup({ provider: 'graph' }); GRAPH_FAIL = new O.MailAuthError('invalid_grant'); const r = await owner(); eq([r.ok, GM.length], [false, 0]);
  setup({ provider: 'graph', backup: true }); GRAPH_FAIL = new Error('Microsoft Graph 503'); eq([(await owner()).ok, GM.length], [false, 0]);   // only a sign-in problem uses the backup
  setup({ provider: 'gmail' }); eq((await owner()).ok, true);
});

// ---------- finding the customer ----------
test('match: the plus-address token still works, for either mailbox', () => {
  eq(tokenFrom(['chaser+tok123abc@gmail.com'], 'chaser@gmail.com'), 'tok123abc');
  eq(tokenFrom(['tiagvjbn+tok123abc@outlook.com'], 'tiagvjbn@outlook.com'), 'tok123abc');
  eq(tokenFrom(['someoneelse+tok123abc@outlook.com'], 'tiagvjbn@outlook.com'), null);
  process.env.GMAIL_ADDRESS = 'chaser@gmail.com'; eq(tokenFrom(['chaser+tok123abc@gmail.com']), 'tok123abc');          // old call, no mailbox given
});
test('match: a reply is found from the email thread even when the sender is a stranger', async () => {
  setup();
  let m = await matchInbound({ fromEmail: 'hubert@gmail.com', conversationId: 'CONV1' }); eq([m.customer.id, m.method, m.senderKnown], ['c1', 'thread', true]);
  m = await matchInbound({ fromEmail: 'hubert@gmail.com', inReplyTo: '<rem1@x>' }); eq([m.customer.id, m.method], ['c1', 'thread']);
  m = await matchInbound({ fromEmail: 'hubert@gmail.com', references: ['<old@x>', '<rem1@x>'] }); eq([m.customer.id, m.method], ['c1', 'thread']);
  m = await matchInbound({ fromEmail: 'hubert@gmail.com', conversationId: 'CONV-ALERT' }); eq(m.customer, null);          // our own alerts are not customer threads
  m = await matchInbound({ fromEmail: 'hubert@gmail.com', conversationId: 'NOPE', inReplyTo: '<nope@x>' }); eq(m.customer, null);
  TABLES.outbound_messages.push({ id: 'o9', customer_id: 'c2', kind: 'owner_alert', status: 'sent', message_id: '<alert2@x>', conversation_id: 'CONV-X', created_at: new Date().toISOString() });
  eq((await matchInbound({ fromEmail: 'hubert@gmail.com', conversationId: 'CONV-X' })).customer, null);      // only reminders and acknowledgements count as customer threads
});
test('match: order of trust is token, then thread, then sender; and a thread pointing at two customers is not trusted', async () => {
  setup();
  let m = await matchInbound({ fromEmail: 'd@dunmore-test.example', toAddresses: ['chaser+tok123abc@gmail.com'], mailbox: 'chaser@gmail.com', conversationId: 'CONV1' }); eq([m.customer.id, m.method], ['c1', 'token']);
  m = await matchInbound({ fromEmail: 'd@dunmore-test.example', conversationId: 'CONV1' }); eq([m.customer.id, m.method], ['c1', 'thread']);
  TABLES.outbound_messages.push({ id: 'o3', customer_id: 'c2', kind: 'reminder', status: 'sent', message_id: '<rem2@x>', conversation_id: 'CONV1', created_at: new Date().toISOString() });
  m = await matchInbound({ fromEmail: 'd@dunmore-test.example', conversationId: 'CONV1' }); eq([m.customer.id, m.method], ['c2', 'sender']);
});
test('match: sender, company domain, invoice number and phone work as before', async () => {
  setup();
  let m = await matchInbound({ fromEmail: 'BILLING@brindley-test.example' }); eq([m.customer.id, m.method], ['c1', 'sender']);
  m = await matchInbound({ fromEmail: 'someone.else@brindley-test.example' }); eq([m.customer.id, m.method], ['c1', 'domain']);
  m = await matchInbound({ fromEmail: 'x@stranger.example', subject: 'About INV-5005' }); eq([m.customer.id, m.method, m.senderKnown], ['c2', 'invoice_number', false]);
  eq((await matchInbound({ fromEmail: 'x@stranger.example', subject: 'hello' })).customer, null);
  TABLES.customers[0].phone = '+447000000001'; m = await matchInbound({ channel: 'sms', fromPhone: '+447000000001' }); eq([m.customer.id, m.method], ['c1', 'phone']);
});

// ---------- the whole reply pipeline ----------
test('inbox (Microsoft): a reply from a stranger address is matched by thread, acted on, answered in-thread, and marked read', async () => {
  setup({ provider: 'graph' }); GRAPH_INBOX = [graphMsg()];
  const r = await pollInbox(); eq([r.fetched, r.replies, r.errors, r.unmatched], [1, 1, 0, 0]);
  const row = TABLES.inbound_messages[0];
  eq([row.match_method, row.graph_message_id, row.intent, row.customer_id, row.kind], ['thread', 'GID-IN', 'promise_to_pay', 'c1', 'reply']);
  eq([TABLES.invoices[0].status, TABLES.invoices[0].promised_count], ['promised', 1]);
  const ack = GR.find(c => c[0] === 'sendReply'); assert(ack); eq([ack[1].graphMessageId, ack[1].to], ['GID-IN', 'owner@acme.example']);
  eq(GR.find(c => c[0] === 'markSeen')[1], ['GID-IN']); eq(GM.length, 0);
  eq(TABLES.outbound_messages.filter(o => o.kind === 'ack').map(o => [o.graph_message_id, o.conversation_id]), [['GID-REPLY', 'CONV1']]);
});
test('inbox (Microsoft): a dispute opens a task and alerts the owner, same as with Gmail', async () => {
  setup({ provider: 'graph' }); CLS = { ...CLS, intent: 'dispute', promised_date: null, dispute_category: 'missing_po', dispute_reason: 'Need a PO' }; GRAPH_INBOX = [graphMsg({ text: 'We need a PO number.' })];
  await pollInbox(); eq(TABLES.invoices[0].status, 'disputed'); eq(TABLES.tasks.length, 1); eq(TABLES.tasks[0].category, 'missing_po');
  eq(ALERTS.length, 1); assert(ALERTS[0].headline.includes('PO number missing')); eq(GR.filter(c => c[0] === 'sendReply').length, 0);   // no auto reply to a dispute
});
test('inbox (Gmail): still works exactly as before, with the plus-address and Gmail threading', async () => {
  setup({ provider: 'gmail' });
  GMAIL_INBOX = [{ uid: 77, messageId: '<in2@mail>', from: { address: 'billing@brindley-test.example', name: 'Sam' }, to: ['chaser+tok123abc@gmail.com'], subject: 'Re: Invoice INV-5003', text: 'We will pay on Friday.', date: new Date().toISOString(), headers: {}, references: ['<rem1@x>'] }];
  const r = await pollInbox(); eq([r.replies, r.errors], [1, 0]);
  eq([TABLES.inbound_messages[0].match_method, 'graph_message_id' in TABLES.inbound_messages[0]], ['token', false]);
  const ack = GM.find(c => c[0] === 'sendMail'); eq([ack[1].inReplyTo, ack[1].to, ack[1].references], ['<in2@mail>', 'owner@acme.example', ['<rem1@x>', '<in2@mail>']]);
  eq(GM.find(c => c[0] === 'markSeen')[1], [77]); eq(GR.length, 0);
  assert(!('graph_message_id' in TABLES.outbound_messages[TABLES.outbound_messages.length - 1]));
});
test('inbox: our own mail is skipped, one bad email does not stop the rest, and everything is marked read', async () => {
  setup({ provider: 'graph' }); CLS_FAIL = 'EXPLODE';
  GRAPH_INBOX = [graphMsg({ uid: 'A', graphMessageId: 'A', messageId: '<a@m>', from: { address: 'tiagvjbn@outlook.com', name: '' }, to: ['someone@x.com'], conversationId: null, inReplyTo: null, references: [] }),
    graphMsg({ uid: 'B', graphMessageId: 'B', messageId: '<b@m>', text: 'EXPLODE please' }), graphMsg({ uid: 'C', graphMessageId: 'C', messageId: '<c@m>' })];
  const r = await pollInbox(); eq([r.fetched, r.replies, r.errors], [3, 1, 1]);
  eq(GR.find(c => c[0] === 'markSeen')[1], ['A', 'B', 'C']); assert(ALERTS.some(a => a.headline.includes("Couldn't process")));
});
test('inbox: when the Microsoft sign-in is gone, the owner is told once with how to fix it, and the run reports the problem', async () => {
  setup({ provider: 'graph', env: { APP_DOMAIN: 'invoice-chaser-alpha.vercel.app' } }); GRAPH_FAIL = new O.MailAuthError('The Microsoft mailbox needs to be reconnected');
  await assert.rejects(() => pollInbox(), O.MailAuthError);
  eq(ALERTS.length, 1); const a = ALERTS[0]; eq([a.key, a.level, a.dedupeHours], ['mail_reconnect', 'urgent', 24]); assert(a.lines.join(' ').includes('/api/mail/connect'));
  setup({ provider: 'graph' }); GRAPH_FAIL = new Error('Microsoft Graph 503'); await assert.rejects(() => pollInbox(), /503/); eq(ALERTS.length, 0);
});

(async () => {
  for (const [name, fn] of tests) { try { await fn(); passed++; } catch (e) { failures.push(`✗ ${name}\n    ${String(e.message).split('\n').slice(0, 14).join('\n    ')}`); } }
  console.log(failures.length ? failures.join('\n') : '');
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
