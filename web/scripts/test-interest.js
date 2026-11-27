// node scripts/test-interest.js  — checks IC2: UK late-payment interest. Fake database and mailer: nothing real is touched.
// The interest is an ESTIMATE shown to YOU. Nothing is ever added to an invoice, and nothing about amounts goes to a customer.
process.env.GMAIL_ADDRESS = 'chaser@example.com';
process.env.ACTION_SECRET = 'test-secret-test-secret-123';
const assert = require('assert');
const eq = assert.deepStrictEqual;

// ---- stand-in database: every query answers from ROWS ----
let ROWS = {}, ALERTS = [], SENT = [];
function chain(table) {
  const calls = [];
  const proxy = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (resolve, reject) => {
        let data = ROWS[table] || [];
        if (table === 'invoices') data = calls.some(c => c[0] === 'eq' && c[1] === 'status' && c[2] === 'paid') ? (ROWS.paid || []) : (ROWS.open || []);
        return Promise.resolve({ data, error: null, count: data.length }).then(resolve, reject);
      };
      return (...args) => { calls.push([prop, ...args]); return proxy; };
    }
  });
  return proxy;
}
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const inject = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
inject('../lib/db', { supabase: { from: chain }, must, fetchAll: async b => must(await b()), logEvent: async () => {} });
inject('../lib/outbound', { sendOwnerEmail: async o => { SENT.push(o); return { ok: true }; } });
inject('../lib/notify', { alertOwner: async a => { ALERTS.push(a); return { sent: true }; } });

const { getConfig } = require('../lib/config');
const L = require('../lib/lateinterest');
const D = require('../lib/dates');
const T = require('../lib/templates');
const { computeMetrics } = require('../lib/metrics');
const { buildReport, sendWeeklyReport } = require('../lib/report');

const RATES = { '2025-12-31': 3.75, '2026-06-30': 3.75 };
const ENV = { BUSINESS_NAME: 'Acme Ltd', PAYMENT_INSTRUCTIONS: 'Sort code 00-00-00', STATUTORY_INTEREST_MODE: 'owner', BASE_RATES_JSON: JSON.stringify(RATES) };
const cfgOf = (extra = {}) => getConfig({ ...ENV, ...extra });
const cust = (o = {}) => ({ id: 'c1', name: 'Brindley Ltd', contact_name: 'Sam', email: 'ap@x.example', ...o });
const inv = (o = {}) => ({ id: 'i1', invoice_number: 'INV-1', customer_id: 'c1', currency: 'GBP', amount_cents: 100000, amount_paid_cents: 0, amount_credited_cents: 0, status: 'open', due_date: '2026-09-30', customers: cust(), ...o });

let passed = 0; const failures = [], tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- the rules ----------
test('reference date: interest starts the day after the due date, and the half-year decides the base rate', () => {
  eq(L.referenceDate('2026-06-29'), '2025-12-31');        // starts 30 Jun: first half-year
  eq(L.referenceDate('2026-06-30'), '2026-06-30');        // starts 1 Jul: second half-year
  eq(L.referenceDate('2026-12-30'), '2026-06-30');        // starts 31 Dec
  eq(L.referenceDate('2026-12-31'), '2026-12-31');        // starts 1 Jan next year
  eq(L.referenceDate('2026-01-01'), '2025-12-31');
});
test('fixed recovery sum: under £1,000 = £40, £1,000 to £9,999.99 = £70, £10,000 and over = £100', () => {
  eq([0, 1, 99999, 100000, 999999, 1000000, 5000000].map(L.compensationFor), [0, 4000, 4000, 7000, 7000, 10000, 10000]);
});
test('worked example: £1,000 overdue 30 days at 11.75% = £9.66 interest plus £70', () => {
  const r = L.calcInterest({ balanceCents: 100000, dueDate: '2026-09-30', today: '2026-10-30', rateTable: RATES });
  eq([r.state, r.days, r.ratePct, r.interestCents, r.compensationCents, r.totalCents, r.referenceDate, r.source], ['ok', 30, 11.75, 966, 7000, 7966, '2026-06-30', 'statutory']);
  eq(L.calcInterest({ balanceCents: 1000000, dueDate: '2026-09-30', today: '2026-10-10', rateTable: RATES }).compensationCents, 10000);
  eq(L.calcInterest({ balanceCents: 50000, dueDate: '2026-09-30', today: '2026-10-30', rateTable: RATES }).compensationCents, 4000);
});
test('the rate is picked from the interest start date, and a missing rate is reported, never guessed', () => {
  const t = { ...RATES, '2026-12-31': 4 };
  eq(L.calcInterest({ balanceCents: 100000, dueDate: '2026-12-31', today: '2027-01-30', rateTable: t }).ratePct, 12);      // starts 1 Jan: base on 31 Dec 2026
  eq(L.calcInterest({ balanceCents: 100000, dueDate: '2026-12-30', today: '2027-01-30', rateTable: t }).ratePct, 11.75);   // starts 31 Dec: base on 30 Jun 2026
  eq(L.calcInterest({ balanceCents: 100000, dueDate: '2026-12-31', today: '2027-01-30', rateTable: RATES }), { state: 'rate_missing', referenceDate: '2026-12-31', days: 30 });
  eq(L.calcInterest({ balanceCents: 100000, dueDate: '2026-12-31', today: '2027-01-30', rateTable: {} }).state, 'rate_missing');
});
test('the rate stays fixed for the life of the debt, even when the base rate changes later', () => {
  const t = { ...RATES, '2026-12-31': 4 };
  const r = L.calcInterest({ balanceCents: 100000, dueDate: '2026-09-30', today: '2027-03-31', rateTable: t });
  eq([r.ratePct, r.referenceDate], [11.75, '2026-06-30']);
});
test('a contract rate replaces the statutory rate, and then no fixed sum is added', () => {
  const r = L.calcInterest({ balanceCents: 100000, dueDate: '2026-09-30', today: '2026-10-30', rateTable: {}, contractRatePct: 10 });
  eq([r.state, r.source, r.ratePct, r.interestCents, r.compensationCents], ['ok', 'contract', 10, 822, 0]);
});
test('nothing is due before the day after the due date, or on a zero balance', () => {
  eq(L.calcInterest({ balanceCents: 100000, dueDate: '2026-09-30', today: '2026-09-30', rateTable: RATES }).state, 'not_late');
  eq(L.calcInterest({ balanceCents: 100000, dueDate: '2026-09-30', today: '2026-09-29', rateTable: RATES }).state, 'not_late');
  eq(L.calcInterest({ balanceCents: 0, dueDate: '2026-09-30', today: '2026-10-30', rateTable: RATES }).state, 'not_late');
  eq(L.calcInterest({ balanceCents: 100000, dueDate: '2026-09-30', today: '2026-10-01', rateTable: RATES }).days, 1);
});

// ---------- one invoice ----------
const T0 = '2026-10-30';
test('invoice: off means nothing at all, and the on-modes calculate', () => {
  eq(L.interestForInvoice(inv(), { today: T0, cfg: getConfig({ ...ENV, STATUTORY_INTEREST_MODE: 'off' }) }), null);
  eq(L.interestForInvoice(inv(), { today: T0, cfg: cfgOf() }).interestCents, 966);
  eq(L.interestForInvoice(inv(), { today: T0, cfg: cfgOf({ STATUTORY_INTEREST_MODE: 'mention' }) }).interestCents, 966);
});
test('invoice: part-paid or credited invoices are left to be calculated by hand', () => {
  eq(L.interestForInvoice(inv({ amount_paid_cents: 20000 }), { today: T0, cfg: cfgOf() }), { state: 'by_hand' });
  eq(L.interestForInvoice(inv({ amount_credited_cents: 20000 }), { today: T0, cfg: cfgOf() }), { state: 'by_hand' });
  eq(L.interestForInvoice(inv({ amount_paid_cents: 20000, due_date: '2026-11-15' }), { today: T0, cfg: cfgOf() }), { state: 'not_late' });   // not late yet: nothing to do by hand
});
test('invoice: disputed or "says paid" invoices and other currencies show no estimate', () => {
  eq(L.interestForInvoice(inv({ status: 'disputed' }), { today: T0, cfg: cfgOf() }), { state: 'not_claimable' });
  eq(L.interestForInvoice(inv({ status: 'payment_claimed' }), { today: T0, cfg: cfgOf() }), { state: 'not_claimable' });
  eq(L.interestForInvoice(inv({ currency: 'USD' }), { today: T0, cfg: cfgOf() }), { state: 'other_currency' });
});
test('invoice: the customer\'s contract rate is used when it is set', () => {
  const r = L.interestForInvoice(inv({ customers: cust({ contract_interest_pct: '10' }) }), { today: T0, cfg: cfgOf() });
  eq([r.source, r.interestCents, r.compensationCents], ['contract', 822, 0]);
  eq(L.interestForInvoice(inv({ customers: cust({ contract_interest_pct: null }) }), { today: T0, cfg: cfgOf() }).source, 'statutory');
});
test('roll-up: adds up the estimates, counts the by-hand ones and lists each missing base rate once', () => {
  const list = [inv(), inv({ id: 'i2', amount_paid_cents: 5000 }), inv({ id: 'i3', status: 'disputed' }), inv({ id: 'i4', due_date: '2026-12-31' }), inv({ id: 'i5', due_date: '2026-12-31' })];
  const r = L.interestRollup(list, { today: '2027-01-15', cfg: cfgOf({ BASE_RATES_JSON: '{"2026-06-30":3.75}' }) });
  eq(r, { interestCents: 3445, compensationCents: 7000, count: 1, byHand: 1, missing: ['2026-12-31'] });
});

// ---------- the settings ----------
test('settings: interest is OFF by default, modes are checked, and bad rates are ignored with a warning', () => {
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    eq(getConfig({}).interest, { mode: 'off', baseRates: {} });
    eq(getConfig({ STATUTORY_INTEREST_MODE: ' Mention ' }).interest.mode, 'mention');
    eq(getConfig({ STATUTORY_INTEREST_MODE: 'show' }).interest.mode, 'off');                      // not a mode: stays off
    eq(getConfig({ BASE_RATES_JSON: '{"2026-06-30": 3.75, "2025-12-31": "4"}' }).interest.baseRates, { '2026-06-30': 3.75, '2025-12-31': 4 });
    eq([getConfig({ BASE_RATES_JSON: 'not json' }).interest.baseRates, getConfig({ BASE_RATES_JSON: '{"2026-05-01": 3}' }).interest.baseRates, getConfig({ BASE_RATES_JSON: '{"2026-06-30": "high"}' }).interest.baseRates, getConfig({ BASE_RATES_JSON: '[1]' }).interest.baseRates], [{}, {}, {}, {}]);
    eq(warned, 4);
  } finally { console.warn = warn; }
});

// ---------- the customer's emails ----------
const send = (tone, cfg, customer = cust()) => T.renderReminder({ tone, customer, invoices: [inv()], cfg, today: T0 });
const NOTE = 'Late Payment of Commercial Debts (Interest) Act 1998';
test('emails: with the setting off or "owner", no email changes at all, in any tone', () => {
  const off = getConfig({ ...ENV, STATUTORY_INTEREST_MODE: 'off' });
  for (const tone of ['friendly', 'follow_up', 'firm', 'final', 'broken_promise']) {
    const a = send(tone, off), b = send(tone, cfgOf());
    eq([a.text.includes(NOTE), b.text.includes(NOTE), a.text === b.text, a.html === b.html], [false, false, true, true]);
  }
});
test('emails: "mention" adds one fixed sentence to the firm and final reminders only, and never an amount', () => {
  const m = cfgOf({ STATUTORY_INTEREST_MODE: 'mention' });
  for (const tone of ['firm', 'final']) { const r = send(tone, m); assert(r.text.includes(NOTE) && r.html.includes(NOTE), tone); assert(!/£9\.66|£70|interest of|per cent|%/i.test(r.text), 'no amounts: ' + tone); }
  for (const tone of ['friendly', 'follow_up', 'broken_promise']) assert(!send(tone, m).text.includes(NOTE), tone);
  const plain = send('firm', cfgOf()).text, withNote = send('firm', m).text;
  eq(withNote.split('\n').length - plain.split('\n').length, 2);                    // exactly one blank line and one sentence more
});
test('emails: a customer with their own contract rate never gets the statutory sentence', () => {
  const m = cfgOf({ STATUTORY_INTEREST_MODE: 'mention' });
  assert(!send('final', m, cust({ contract_interest_pct: 8 })).text.includes(NOTE));
  assert(send('final', m, cust({ contract_interest_pct: null })).text.includes(NOTE));
});

// ---------- the numbers and the weekly report ----------
const stats = { reminders: 0, replies: 0, promises: 0, broken: 0, paid: 0 };
test('metrics: the estimate appears only while the setting is on, and counts only the default currency', () => {
  const cfg = cfgOf(), today = '2026-10-30';
  const m = computeMetrics({ invoices: [inv(), inv({ id: 'i9', currency: 'USD' })], today, cfg });
  eq([m.interest.interestCents, m.interest.compensationCents, m.interest.count], [966, 7000, 1]);
  eq(computeMetrics({ invoices: [inv()], today, cfg: getConfig({ ...ENV, STATUTORY_INTEREST_MODE: 'off' }) }).interest, null);
});
test('report: has a Late-payment interest section, with money in pounds, and none while the setting is off', () => {
  const today = '2026-10-30';
  const on = buildReport({ today, open: [inv()], paid: [], stats, cfg: cfgOf() });
  assert(on.text.includes('Late-payment interest') && on.text.includes('£9.66') && on.text.includes('£70.00') && on.text.includes('nothing is added to any invoice automatically'));
  assert(on.html.includes('Late-payment interest') && on.html.includes('£9.66'));
  const off = buildReport({ today, open: [inv()], paid: [], stats, cfg: getConfig({ ...ENV, STATUTORY_INTEREST_MODE: 'off' }) });
  assert(!off.text.includes('Late-payment interest') && !off.html.includes('Late-payment interest'));
  const none = buildReport({ today, open: [inv({ due_date: '2026-12-01' })], paid: [], stats, cfg: cfgOf() }); assert(none.text.includes('No late-payment interest to claim right now.'));
  const hand = buildReport({ today, open: [inv({ amount_paid_cents: 100 })], paid: [], stats, cfg: cfgOf() }); assert(hand.text.includes('1 part-paid or credited invoice must be calculated by hand.'));
});
test('report: a missing base rate is flagged in the report, and the owner is alerted once a week when it is sent', async () => {
  const today = D.todayISO('Europe/London'), late = { ...inv({ due_date: D.addDays(today, -30) }) };
  const set = env => { for (const k of ['STATUTORY_INTEREST_MODE', 'BASE_RATES_JSON']) delete process.env[k]; Object.assign(process.env, env); };
  ROWS = { open: [late], paid: [] };
  const ref = L.referenceDate(late.due_date);
  set({ STATUTORY_INTEREST_MODE: 'owner', BASE_RATES_JSON: '{}' });
  const prev = await sendWeeklyReport({ preview: true });
  assert(prev.text.includes(`Add the Bank of England base rate for ${ref}`)); eq(ALERTS.length, 0);          // a preview never alerts
  ALERTS = []; SENT = []; const r = await sendWeeklyReport({ force: true });
  eq([r.sent, SENT.length, ALERTS.length], [true, 1, 1]);
  eq([ALERTS[0].key, ALERTS[0].level, ALERTS[0].dedupeHours], [`base_rate_missing:${ref}`, 'action', 144]); assert(ALERTS[0].lines.join(' ').includes('BASE_RATES_JSON'));
  ALERTS = []; set({ STATUTORY_INTEREST_MODE: 'owner', BASE_RATES_JSON: JSON.stringify({ [ref]: 3.75 }) });
  await sendWeeklyReport({ force: true }); eq(ALERTS.length, 0);                                           // rate present: quiet
  set({ STATUTORY_INTEREST_MODE: 'off', BASE_RATES_JSON: '{}' }); await sendWeeklyReport({ force: true }); eq(ALERTS.length, 0);   // feature off: quiet
  set({});
});

(async () => {
  for (const [name, fn] of tests) { try { await fn(); passed++; } catch (e) { failures.push(`✗ ${name}\n    ${String(e.message).split('\n').slice(0, 8).join('\n    ')}`); } }
  console.log(failures.length ? failures.join('\n') : '');
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();