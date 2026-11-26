// node scripts/test-credits.js  — checks IC1-0: credit notes are kept apart from cash.
// A credit note lowers what is owed, but it is never "money collected". Fake database: nothing real is touched.
process.env.GMAIL_ADDRESS = 'chaser@example.com';
const assert = require('assert');
const eq = assert.deepStrictEqual;

// ---- stand-in database (only what these tests need) ----
let TABLES = {}, EVENTS = [], SEQ = 0;
function from(name) {
  let op = 'select', filters = [], payload = null, one = false, after = false, lim = null;
  const api = {
    select() { after = true; return api; },
    insert(p) { op = 'insert'; payload = p; return api; },
    update(p) { op = 'update'; payload = p; return api; },
    eq(c, v) { filters.push(r => r[c] === v); return api; },
    neq(c, v) { filters.push(r => r[c] !== v); return api; },
    is(c, v) { filters.push(r => (r[c] === undefined ? null : r[c]) === v); return api; },
    like(c, pat) { const re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$'); filters.push(r => re.test(String(r[c] || ''))); return api; },
    in(c, vs) { filters.push(r => vs.includes(r[c])); return api; },
    limit(n) { lim = n; return api; },
    single() { one = true; return api; }, maybeSingle() { one = true; return api; },
    then(resolve, reject) {
      const rows = TABLES[name] = TABLES[name] || [];
      let hit = rows.filter(r => filters.every(f => f(r)));
      if (lim) hit = hit.slice(0, lim);
      let out;
      if (op === 'insert') { const row = { id: `${name}-${++SEQ}`, ...payload }; rows.push(row); out = { data: after ? (one ? row : [row]) : null, error: null }; }
      else if (op === 'update') { hit.forEach(r => Object.assign(r, payload)); out = { data: after ? (one ? hit[0] || null : hit) : null, error: null }; }
      else out = { data: one ? hit[0] || null : hit, error: null };
      if (out.data) out.data = JSON.parse(JSON.stringify(out.data));          // like the real database: you get a copy, not the stored row
      return Promise.resolve(out).then(resolve, reject);
    }
  };
  return api;
}
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const inject = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
inject('../lib/db', { supabase: { from }, must, fetchAll: async b => must(await b()), logEvent: async e => { EVENTS.push(e); } });
inject('../lib/tasks', { updateTasks: async () => {} });

const { getConfig } = require('../lib/config');
const { balanceCents } = require('../lib/money');
const { computeMetrics } = require('../lib/metrics');
const { stepFor } = require('../lib/sequence');
const { performAction } = require('../lib/actions');
const { upsertInvoice } = require('../lib/ingest');

const cfg = getConfig({ BUSINESS_TIMEZONE: 'Europe/London', BUSINESS_LOCALE: 'en-GB', DEFAULT_CURRENCY: 'GBP' });
const TODAY = '2026-09-30';
let passed = 0; const failures = [], tests = [];
const test = (name, fn) => tests.push([name, fn]);

const inv = (o = {}) => ({ id: 'i1', customer_id: 'c1', invoice_number: 'INV-1', currency: 'GBP', amount_cents: 100000, amount_paid_cents: 0, amount_credited_cents: 0, status: 'open', due_date: '2026-09-10', reminder_count: 0, last_reminder_at: null, ...o });
const fresh = (invoices = []) => { SEQ = 0; EVENTS = []; TABLES = { customers: [{ id: 'c1', name: 'Brindley Ltd', email: 'ap@brindley-test.example', phone: null, contact_name: null }], invoices }; };
const row = id => TABLES.invoices.find(r => r.id === id);
const raw = (o = {}) => ({ invoice_number: 'INV-1', customer_name: 'Brindley Ltd', customer_email: 'ap@brindley-test.example', amount: 1000, due_date: '2026-09-10', ...o });
const types = () => EVENTS.map(e => e.type);

// ---------- the balance ----------
test('balance: a plain invoice is unchanged (total minus cash)', () => {
  eq(balanceCents({ amount_cents: 1000, amount_paid_cents: 400 }), 600);
  eq(balanceCents({ amount_cents: 1000 }), 1000);
});
test('balance: credit notes lower what is owed', () => {
  eq(balanceCents({ amount_cents: 1000, amount_credited_cents: 1000 }), 0);                       // fully credited
  eq(balanceCents({ amount_cents: 1000, amount_credited_cents: 300 }), 700);                      // part credited
  eq(balanceCents({ amount_cents: 1000, amount_paid_cents: 200, amount_credited_cents: 300 }), 500);   // part paid + part credited
  eq(balanceCents({ amount_cents: 1000, amount_paid_cents: 800, amount_credited_cents: 500 }), 0);     // never below zero
});
test('chasing: a fully credited invoice is not chased; a part credited one is, for the rest only', () => {
  const ctx = { today: TODAY, cfg };
  eq(stepFor(inv({ amount_credited_cents: 100000 }), ctx), null);
  const s = stepFor(inv({ amount_credited_cents: 30000 }), ctx); assert(s && s.tone === 'friendly');
});

// ---------- the numbers ----------
test('metrics: outstanding counts only what is still owed after credit', () => {
  const m = computeMetrics({ invoices: [inv({ amount_credited_cents: 40000 })], today: TODAY, cfg });
  eq([m.outstanding.cents, m.overdue.cents], [60000, 60000]);
});
test('metrics: "collected" and "days to pay" count cash only, never credit notes', () => {
  const list = [
    inv({ id: 'A', status: 'paid', paid_at: '2026-09-28T15:00:00Z', issue_date: '2026-09-01', due_date: '2026-09-15', amount_cents: 100000, amount_paid_cents: 0, amount_credited_cents: 100000 }),   // closed by a credit note alone
    inv({ id: 'B', status: 'paid', paid_at: '2026-09-28T15:00:00Z', issue_date: '2026-09-01', due_date: '2026-09-15', amount_cents: 100000, amount_paid_cents: 70000, amount_credited_cents: 30000 }),  // cash 700 + credit 300
    inv({ id: 'C', status: 'paid', paid_at: '2026-09-29T10:00:00Z', issue_date: '2026-09-10', due_date: '2026-09-20', amount_cents: 50000, amount_paid_cents: 50000 })                                // a plain paid invoice
  ];
  const m = computeMetrics({ invoices: list, today: TODAY, cfg });
  eq([m.collected.week.cents, m.collected.week.count, m.collected.month.cents], [120000, 2, 120000]);
  eq([m.avgDaysToPay, m.avgDaysLate], [23, 11]);                       // the credit-only invoice (27 days) is left out
  const credOnly = computeMetrics({ invoices: [list[0]], today: TODAY, cfg });
  eq([credOnly.collected.week.cents, credOnly.collected.week.count, credOnly.avgDaysToPay], [0, 0, null]);
});

// ---------- the owner's buttons ----------
test('mark paid: a plain invoice counts its full total as cash (unchanged)', async () => {
  fresh([inv()]); await performAction({ action: 'mark_paid', invoiceId: 'i1' });
  eq([row('i1').status, row('i1').amount_paid_cents], ['paid', 100000]);
});
test('mark paid: a part credited invoice counts only the cash part', async () => {
  fresh([inv({ amount_credited_cents: 30000 })]); await performAction({ action: 'mark_paid', invoiceId: 'i1' });
  eq([row('i1').status, row('i1').amount_paid_cents], ['paid', 70000]);
});
test('mark paid: a fully credited invoice closes with no cash at all', async () => {
  fresh([inv({ amount_credited_cents: 100000 })]); await performAction({ action: 'mark_paid', invoiceId: 'i1' });
  eq([row('i1').status, row('i1').amount_paid_cents], ['paid', 0]);
});
test('part payment: closes only when cash + credit cover the invoice', async () => {
  fresh([inv({ amount_credited_cents: 30000 })]);
  await performAction({ action: 'partial_payment', invoiceId: 'i1', params: { amount: '400.00' } });
  eq([row('i1').status, row('i1').amount_paid_cents, balanceCents(row('i1'))], ['open', 40000, 30000]);
  await performAction({ action: 'partial_payment', invoiceId: 'i1', params: { amount: '300.00' } });
  eq([row('i1').status, row('i1').amount_paid_cents, balanceCents(row('i1'))], ['paid', 70000, 0]);
  eq(types(), ['partial_payment', 'mark_paid']);
});
test('part payment: a plain invoice behaves as before', async () => {
  fresh([inv()]);
  await performAction({ action: 'partial_payment', invoiceId: 'i1', params: { amount: '400' } }); eq([row('i1').status, row('i1').amount_paid_cents], ['open', 40000]);
  await performAction({ action: 'partial_payment', invoiceId: 'i1', params: { amount: '900' } }); eq([row('i1').status, row('i1').amount_paid_cents], ['paid', 100000]);   // capped at the total
});
test('actions: an unknown invoice gives a clear error', async () => {
  fresh([]); await assert.rejects(() => performAction({ action: 'mark_paid', invoiceId: 'nope' }), /Invoice not found/);
});

// ---------- invoices coming in (API / Make / Zapier) ----------
test('intake: a new invoice can arrive with a credit note already on it', async () => {
  fresh(); const r = await upsertInvoice(raw({ amount_credited: 300 }), 'api');
  eq([r.action, row(r.invoice.id).amount_credited_cents, row(r.invoice.id).amount_paid_cents], ['created', 30000, 0]);
});
test('intake: a new invoice that is already fully credited is not stored', async () => {
  fresh(); const r = await upsertInvoice(raw({ amount_credited: 1000 }), 'api'); eq([r.action, TABLES.invoices.length], ['ignored', 0]);
});
test('intake: no credit field = nothing changes (the column is left alone)', async () => {
  fresh(); const r = await upsertInvoice(raw(), 'api'); eq(r.action, 'created'); assert(!('amount_credited_cents' in row(r.invoice.id)));
  const again = await upsertInvoice(raw({ amount: 1200 }), 'api'); eq([again.action, row(r.invoice.id).amount_cents, 'amount_credited_cents' in row(r.invoice.id)], ['updated', 120000, false]);
});
test('intake: a part credit on an open invoice is saved, logged once, and the invoice keeps being chased for the rest', async () => {
  fresh([inv()]);
  let r = await upsertInvoice(raw({ amount_credited: 300 }), 'api');
  eq([r.action, row('i1').status, row('i1').amount_credited_cents, balanceCents(row('i1'))], ['updated', 'open', 30000, 70000]);
  eq(types(), ['credit_applied']);
  await upsertInvoice(raw({ amount_credited: 300 }), 'api'); eq(types(), ['credit_applied']);                 // same credit again: no second event
  await upsertInvoice(raw({ amount_credited: 500 }), 'api'); eq(types(), ['credit_applied', 'credit_applied']);   // credit grew: logged
});
test('intake: a credit that covers the whole invoice closes it, with no cash collected', async () => {
  fresh([inv({ status: 'disputed' })]);
  const r = await upsertInvoice(raw({ amount_credited: 1000 }), 'api');
  eq([r.action, row('i1').status, row('i1').amount_paid_cents, row('i1').amount_credited_cents], ['paid', 'paid', 0, 100000]);
  eq(types(), ['credit_applied', 'mark_paid']);
  const m = computeMetrics({ invoices: [{ ...row('i1'), paid_at: new Date().toISOString() }], today: new Date().toISOString().slice(0, 10), cfg });
  eq(m.collected.month.cents, 0);
});
test('intake: cash plus credit that together cover the invoice close it, and only the cash counts as collected', async () => {
  fresh([inv()]);
  const r = await upsertInvoice(raw({ amount_paid: 200, amount_credited: 800 }), 'api');
  eq([r.action, row('i1').status, row('i1').amount_paid_cents, row('i1').amount_credited_cents], ['paid', 'paid', 20000, 80000]);
});
test('intake: a closed invoice is never re-opened by a credit update, and a bad credit is refused', async () => {
  fresh([inv({ status: 'paid', amount_paid_cents: 100000 })]);
  const r = await upsertInvoice(raw({ amount_credited: 100 }), 'api'); eq([r.action, row('i1').status, row('i1').amount_credited_cents], ['ignored', 'paid', 0]);
  fresh([inv()]); const bad = await upsertInvoice(raw({ amount_credited: -5 }), 'api'); eq(bad.ok, false); assert(/amount_credited/.test(bad.error));
});

(async () => {
  for (const [name, fn] of tests) { try { await fn(); passed++; } catch (e) { failures.push(`✗ ${name}\n    ${String(e.message).split('\n').slice(0, 8).join('\n    ')}`); } }
  console.log(failures.length ? failures.join('\n') : '');
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();