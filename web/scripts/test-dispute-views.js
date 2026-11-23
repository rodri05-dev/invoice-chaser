// node scripts/test-dispute-views.js  — checks IC3 part 3: the "nudge" for dispute tasks that wait too long, the
// Disputes line in the weekly report, the data for the Disputes tab, and the dashboard page itself
// (it runs the real dashboard.html with a pretend browser). Nothing real is contacted.
process.env.OWNER_EMAIL = 'owner@acme.example';
process.env.APP_DOMAIN = 'invoice-chaser-alpha.vercel.app';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const eq = assert.deepStrictEqual;

// ---- stand-in database ----
let TABLES = {}, BROKEN = [];
function from(name) {
  let op = 'select', filters = [], payload = null, one = false, after = false, head = false;
  const api = {
    select(cols, opts) { after = true; if (opts && opts.head) head = true; return api; },
    insert(p) { op = 'insert'; payload = p; return api; },
    update(p) { op = 'update'; payload = p; return api; },
    eq(c, v) { filters.push(r => r[c] === v); return api; },
    in(c, vs) { filters.push(r => vs.includes(r[c])); return api; },
    gte() { return api; }, order() { return api; }, limit() { return api; }, range() { return api; },
    single() { one = true; return api; }, maybeSingle() { one = true; return api; },
    then(resolve, reject) {
      if (BROKEN.includes(name)) return Promise.resolve({ data: null, error: { message: `relation "${name}" does not exist` } }).then(resolve, reject);
      const rows = TABLES[name] = TABLES[name] || [];
      const hit = rows.filter(r => filters.every(f => f(r)));
      let out;
      if (op === 'update') { hit.forEach(r => Object.assign(r, payload)); out = { data: after ? hit : null, error: null }; }
      else if (op === 'insert') { rows.push({ id: `${name}-${rows.length + 1}`, ...payload }); out = { data: null, error: null }; }
      else if (head) out = { data: null, count: hit.length, error: null };
      else out = { data: one ? hit[0] || null : hit, error: null };
      return Promise.resolve(out).then(resolve, reject);
    }
  };
  return api;
}
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const fetchAll = async build => must(await build());
const inject = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
inject('../lib/db', { supabase: { from }, must, fetchAll, logEvent: async () => {} });
let ALERTS = [];
inject('../lib/notify', { alertOwner: async a => { ALERTS.push(a); return { sent: true }; } });
inject('../lib/outbound', { sendOwnerEmail: async () => ({ ok: true }) });
inject('../lib/aiusage', { usageSummary: async () => null });
inject('../lib/auth', { isDashboardAuthorized: req => (req.headers || {}).authorization === 'Bearer good' });

const { getConfig } = require('../lib/config');
const { nudgeDisputeTasks, BUTTONS } = require('../lib/nudges');
const { ACTIONS } = require('../lib/actions');
const DS = require('../lib/disputes');
const { loadData, buildReport } = require('../lib/report');
const dashboardData = require('../api/dashboard-data');

const cfg = getConfig({ BUSINESS_NAME: 'Acme Ltd', OWNER_EMAIL: 'owner@acme.example', APP_DOMAIN: 'invoice-chaser-alpha.vercel.app' });
const NOW = '2026-11-22T12:00:00.000Z';
const daysAgo = n => new Date(Date.parse(NOW) - n * 86400000).toISOString();
const task = (o = {}) => ({ id: 't1', invoice_id: 'i1', customer_id: 'c1', category: 'missing_po', status: 'open', note: 'PO number missing', created_at: daysAgo(7), updated_at: daysAgo(7), last_alert_at: null,
  invoices: { id: 'i1', invoice_number: 'INV-5003', status: 'disputed', amount_cents: 900000, amount_paid_cents: 0, currency: 'GBP' }, customers: { name: 'Brindley Construction Ltd' }, ...o });
const fresh = (tasks = [task()]) => { TABLES = { tasks }; BROKEN = []; ALERTS = []; };

let passed = 0; const failures = [], tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- the nudge ----------
test('nudge: a dispute that waited 7 days gets one alert to the owner with the checklist and 5 working buttons', async () => {
  fresh(); const r = await nudgeDisputeTasks({ cfg, nowISO: NOW });
  eq(r, { nudged: 1, closed: 0 }); eq(ALERTS.length, 1);
  const a = ALERTS[0];
  assert(a.headline.includes('Brindley Construction Ltd') && a.headline.includes('INV-5003') && a.headline.includes('7 days') && a.headline.includes('PO number missing'));
  eq(a.level, 'action'); assert(a.dedupeHours > 0); eq([a.invoice, a.customer], [{ id: 'i1' }, { id: 'c1' }]);
  assert(a.lines.some(l => l.includes('Nobody has dealt with this dispute yet')) && a.lines.some(l => l.includes('What to collect')));
  eq(a.actions, BUTTONS); for (const b of a.actions) assert(ACTIONS.includes(b.action), b.action);
  eq(TABLES.tasks[0].last_alert_at, NOW);
});
test('nudge: it does not nag again straight away, and leaves a fresh dispute alone', async () => {
  fresh(); await nudgeDisputeTasks({ cfg, nowISO: NOW }); TABLES.tasks[0].updated_at = NOW; ALERTS = [];
  eq((await nudgeDisputeTasks({ cfg, nowISO: NOW })).nudged, 0); eq((await nudgeDisputeTasks({ cfg, nowISO: new Date(Date.parse(NOW) + 3 * 86400000).toISOString() })).nudged, 0);
  eq((await nudgeDisputeTasks({ cfg, nowISO: new Date(Date.parse(NOW) + 6 * 86400000).toISOString() })).nudged, 1);
  fresh([task({ created_at: daysAgo(1), updated_at: daysAgo(1) })]); eq((await nudgeDisputeTasks({ cfg, nowISO: NOW })).nudged, 0); eq(ALERTS.length, 0);
});
test('nudge: the waiting time can be changed with DISPUTE_TASK_DAYS', async () => {
  const c2 = getConfig({ BUSINESS_NAME: 'Acme', DISPUTE_TASK_DAYS: '2' }); eq(c2.disputeTaskDays, 2);
  fresh([task({ created_at: daysAgo(3), updated_at: daysAgo(3) })]); eq((await nudgeDisputeTasks({ cfg: c2, nowISO: NOW })).nudged, 1);
  fresh([task({ created_at: daysAgo(3), updated_at: daysAgo(3) })]); eq((await nudgeDisputeTasks({ cfg, nowISO: NOW })).nudged, 0);
});
test('nudge: each task status gets its own plain wording', async () => {
  fresh([task({ status: 'waiting_on_customer' })]); await nudgeDisputeTasks({ cfg, nowISO: NOW }); assert(ALERTS[0].lines.some(l => l.includes('customer has not answered')));
  fresh([task({ status: 'credit_note_needed' })]); await nudgeDisputeTasks({ cfg, nowISO: NOW }); assert(ALERTS[0].lines.some(l => l.includes('credit note')));
});
test('nudge: a task whose invoice is no longer disputed is closed quietly', async () => {
  fresh([task({ invoices: { ...task().invoices, status: 'paid' } }), task({ id: 't2', invoices: { ...task().invoices, status: 'void' } }), task({ id: 't3', invoices: { ...task().invoices, status: 'open' } })]);
  eq(await nudgeDisputeTasks({ cfg, nowISO: NOW }), { nudged: 0, closed: 3 }); eq(ALERTS.length, 0);
  eq(TABLES.tasks.map(t => t.status), ['resolved', 'cancelled', 'resolved']); assert(TABLES.tasks.every(t => t.resolved_at));
});
test('nudge: a missing tasks table is harmless', async () => {
  fresh(); BROKEN = ['tasks']; eq(await nudgeDisputeTasks({ cfg, nowISO: NOW }), { nudged: 0, closed: 0 }); eq(ALERTS.length, 0);
});

// ---------- the weekly report ----------
const baseData = () => ({ today: '2026-11-22', open: [], paid: [], stats: { reminders: 3, replies: 2, promises: 1, broken: 0, paid: 1 } });
test('report: the Disputes section lists open disputes, oldest first, and what was new this week', () => {
  const r = buildReport({ ...baseData(), cfg, disputes: {
    open: [{ customer: 'Dunmore Logistics Ltd', invoice: 'INV-5005', reason: 'Amount disputed', status: 'waiting_on_customer', ageDays: 2 }, { customer: 'Brindley Construction Ltd', invoice: 'INV-5003', reason: 'PO number missing', status: 'open', ageDays: 9 }],
    newByReason: { 'PO number missing': 2, 'Amount disputed': 1 } } });
  const lines = r.text.split('\n'); const at = lines.indexOf('Disputes');
  assert(at > 0); eq(lines[at + 1], '  2 open (oldest 9 days)');
  eq(lines[at + 2], '  Brindley Construction Ltd, INV-5003: PO number missing, 9 days (needs you)');
  eq(lines[at + 3], '  Dunmore Logistics Ltd, INV-5005: Amount disputed, 2 days (waiting for the customer)');
  eq(lines[at + 4], '  New this week: PO number missing 2, Amount disputed 1');
  assert(r.html.includes('Disputes') && r.html.includes('2 open (oldest 9 days)') && r.html.includes('INV-5003'));
});
test('report: no disputes says so, an old caller without the new data still works, and names are escaped', () => {
  const none = buildReport({ ...baseData(), cfg, disputes: { open: [], newByReason: {} } });
  assert(none.text.includes('Disputes\n  No open disputes.') && !none.text.includes('New this week:'));
  assert(buildReport({ ...baseData(), cfg }).text.includes('No open disputes.'));
  const evil = buildReport({ ...baseData(), cfg, disputes: { open: [{ customer: '<img src=x onerror=alert(1)>', invoice: 'INV-1', reason: 'Amount disputed', status: 'open', ageDays: 1 }], newByReason: {} } });
  assert(!evil.html.includes('<img src=x'));
});
test('report: loadData reads the open tasks and counts new disputes by reason', async () => {
  const wk = daysAgo(1);
  TABLES = { invoices: [], events: [{ type: 'disputed', details: { category: 'missing_po' }, created_at: wk }, { type: 'disputed', details: { category: 'missing_po' }, created_at: wk }, { type: 'disputed', details: { category: 'wrong_amount' }, created_at: wk }, { type: 'reminder_sent', details: {}, created_at: wk }],
    inbound_messages: [], tasks: [{ category: 'missing_po', status: 'open', created_at: daysAgo(9), invoices: { invoice_number: 'INV-5003' }, customers: { name: 'Brindley' } }, { category: 'other', status: 'resolved', created_at: daysAgo(9), invoices: {}, customers: {} }] };
  BROKEN = []; const d = await loadData(cfg, new Date(NOW));
  eq(d.disputes.newByReason, { 'PO number missing': 2, 'Amount disputed': 1 }); eq(d.disputes.open.length, 1);
  eq([d.disputes.open[0].customer, d.disputes.open[0].invoice, d.disputes.open[0].reason, d.disputes.open[0].ageDays], ['Brindley', 'INV-5003', 'PO number missing', 9]);
  eq(d.stats.reminders, 1);
  BROKEN = ['tasks']; const d2 = await loadData(cfg, new Date(NOW)); eq(d2.disputes.open, []); eq(d2.disputes.newByReason, { 'PO number missing': 2, 'Amount disputed': 1 });
});

// ---------- the data for the Disputes tab ----------
const callData = async headers => { const res = { code: 200, body: null, status(c) { res.code = c; return res; }, json(o) { res.body = o; return res; } }; await dashboardData({ headers }, res); return res; };
test('dashboard data: open disputes come with a plain reason, the checklist and their age', async () => {
  TABLES = { invoices: [], events: [], inbound_messages: [], jobs: [], tasks: [{ id: 't1', invoice_id: 'i1', customer_id: 'c1', category: 'missing_po', status: 'waiting_on_customer', assignee_email: 'owner@acme.example', note: 'n', created_at: new Date(Date.now() - 4 * 86400000).toISOString(), invoices: { invoice_number: 'INV-5003', amount_cents: 900000, amount_paid_cents: 0, currency: 'GBP' }, customers: { name: 'Brindley' } }, { id: 't2', status: 'resolved', category: 'other', created_at: daysAgo(1) }] }; BROKEN = [];
  eq((await callData({})).code, 401);
  const r = await callData({ authorization: 'Bearer good' }); eq(r.code, 200); eq(r.body.disputes.length, 1);
  const d = r.body.disputes[0];
  eq([d.invoiceId, d.customer, d.invoice, d.cents, d.reason, d.status, d.assignee, d.ageDays], ['i1', 'Brindley', 'INV-5003', 900000, 'PO number missing', 'waiting_on_customer', 'owner@acme.example', 4]);
  eq(d.collect, DS.INFO.missing_po.collect);
});
test('dashboard data: a missing tasks table just means an empty Disputes tab', async () => {
  TABLES = { invoices: [], events: [], inbound_messages: [], jobs: [], tasks: [] }; BROKEN = ['tasks'];
  const r = await callData({ authorization: 'Bearer good' }); eq([r.code, r.body.disputes], [200, []]);
});

// ---------- the dashboard page, run with a pretend browser ----------
function pretendBrowser(data) {
  const els = {}, handlers = {}, calls = [];
  const el = sel => els[sel] || (els[sel] = { innerHTML: '', textContent: '', className: '', hidden: false, dataset: {}, value: '', focus() {}, click() {}, setSelectionRange() {}, scrollIntoView() {}, insertAdjacentElement(_, e) { return e; } });
  const ctx = vm.createContext({
    document: { querySelector: el, addEventListener: (t, f) => { (handlers[t] = handlers[t] || []).push(f); }, createElement: () => ({}), title: '' },
    localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
    fetch: async (url, opts = {}) => { calls.push({ url, body: opts.body && JSON.parse(opts.body) }); return { status: 200, ok: true, json: async () => data }; },
    confirm: msg => { calls.push({ confirm: msg }); return true; }, prompt: () => '7', alert: m => calls.push({ alert: m }), Intl, Date, console
  });
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  return { ctx, el, handlers, calls, run: () => vm.runInContext(script, ctx), eval: code => vm.runInContext(code, ctx) };
}
const age = { label: 'x', cents: 0, count: 0 };
const fixture = (over = {}) => ({
  business: 'Acme Ltd', currency: 'GBP', locale: 'en-GB', dryRun: true, testOverride: false, today: '2026-11-22', ai: null, jobs: [], replies: [], events: [], stats: {},
  metrics: { outstanding: { cents: 900000, count: 1 }, overdue: { cents: 900000, count: 1 }, aging: { current: age, d1_30: age, d31_60: { ...age, cents: 900000, count: 1 }, d61_90: age, d90plus: age }, collected: { week: { cents: 0, count: 0 } }, avgDaysToPay: null, promisedNext7: [] },
  attention: [{ id: 'i1', customerId: 'c1', invoice: 'INV-5003', customer: 'Brindley', cents: 900000, late: 45, reason: 'disputed', note: 'PO number missing' }],
  invoices: [{ id: 'i1', customerId: 'c1', number: 'INV-5003', customer: 'Brindley', email: 'b@x', status: 'disputed', note: 'PO number missing', cents: 900000, due: '2026-10-07', late: 45, reminders: 1 },
             { id: 'i2', customerId: 'c2', number: 'INV-5004', customer: 'Canal', email: 'c@x', status: 'open', cents: 180000, due: '2026-11-26', late: -4, reminders: 0 }],
  disputes: [{ id: 't1', invoiceId: 'i1', customerId: 'c1', customer: 'Brindley <b>Ltd</b>', invoice: 'INV-5003', cents: 900000, reason: 'PO number missing', status: 'waiting_on_customer', note: 'n', assignee: 'owner@acme.example', ageDays: 4, collect: ['Find the PO number', 'Ask <i>who</i> approves'] }],
  ...over });
const tick = () => new Promise(r => setImmediate(r));
const clickOn = (b, attrs) => b.handlers.click[0]({ target: { id: '', closest: sel => (sel === '[data-act]' ? { dataset: attrs } : null) } });

test('dashboard: there is a Disputes tab with a count, and the page script runs', async () => {
  const b = pretendBrowser(fixture()); b.run(); await tick(); await tick();
  const tabs = b.el('#tabs').innerHTML;
  assert(tabs.includes('Disputes (1)') && tabs.indexOf('Needs you') < tabs.indexOf('Disputes') && tabs.indexOf('Disputes') < tabs.indexOf('Invoices'));
});
test('dashboard: the Disputes tab shows reason, age, status, the checklist and the 5 buttons (and escapes names)', async () => {
  const b = pretendBrowser(fixture()); b.run(); await tick(); await tick(); b.eval("tab = 'disputes'; render();");
  const v = b.el('#view').innerHTML;
  assert(v.includes('PO number missing') && v.includes('open 4 days') && v.includes('Waiting for the customer') && v.includes('What to collect') && v.includes('<li>Find the PO number</li>'));
  assert(!v.includes('<b>Ltd</b>') && !v.includes('<i>who</i>') && v.includes('&lt;b&gt;Ltd&lt;/b&gt;'));
  for (const a of ['evidence_sent', 'resume', 'credit_note_needed', 'mark_paid', 'void']) assert(v.includes(`data-act="${a}" data-id="i1"`), a);
});
test('dashboard: no disputes shows a friendly empty message, and an old server without the data does not break it', async () => {
  let b = pretendBrowser(fixture({ disputes: [] })); b.run(); await tick(); await tick(); b.eval("tab = 'disputes'; render();");
  assert(b.el('#view').innerHTML.includes('No open disputes')); assert(b.el('#tabs').innerHTML.includes('Disputes (0)'));
  const old = fixture(); delete old.disputes; b = pretendBrowser(old); b.run(); await tick(); await tick(); b.eval("tab = 'disputes'; render();");
  assert(b.el('#view').innerHTML.includes('No open disputes'));
});
test('dashboard: disputed invoices get the dispute buttons in "Needs you" and "Invoices"; other invoices are unchanged', async () => {
  const b = pretendBrowser(fixture()); b.run(); await tick(); await tick();
  assert(b.el('#view').innerHTML.includes('data-act="evidence_sent" data-id="i1"') && b.el('#view').innerHTML.includes('data-act="credit_note_needed"'));
  b.eval("tab = 'invoices'; render();"); const inv = b.el('#view').innerHTML;
  assert(inv.includes('data-act="evidence_sent" data-id="i1"') && inv.includes('data-act="snooze" data-id="i2"') && inv.includes('data-act="set_promise" data-id="i2"') && !inv.includes('data-act="evidence_sent" data-id="i2"'));
});
test('dashboard: the new buttons call the invoice-action page, with no pop-up for the two dispute notes and a confirm for Void', async () => {
  const b = pretendBrowser(fixture()); b.run(); await tick(); await tick(); b.calls.length = 0;
  await clickOn(b, { act: 'evidence_sent', id: 'i1' });
  const post = b.calls.find(c => c.url === '/api/invoice-action'); eq(post.body, { action: 'evidence_sent', invoiceId: 'i1', params: {} }); assert(!b.calls.some(c => c.confirm));
  await clickOn(b, { act: 'credit_note_needed', id: 'i1' }); assert(!b.calls.some(c => c.confirm));
  await clickOn(b, { act: 'void', id: 'i1' }); assert(b.calls.some(c => c.confirm && c.confirm.includes('Void')));
});

(async () => {
  for (const [name, fn] of tests) { try { await fn(); passed++; } catch (e) { failures.push(`✗ ${name}\n    ${String(e.message).split('\n').slice(0, 30).join('\n    ')}`); } }
  console.log(failures.length ? failures.join('\n') : '');
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();