// node scripts/test-logic.js  — checks every rule of the engine with NO database, email or AI involved.
// Run it after any change to the sequence, templates, reply parsing or policy. Takes about a second.
process.env.GMAIL_ADDRESS = 'chaser@example.com';
process.env.ACTION_SECRET = 'test-secret-test-secret-123';
delete process.env.DASHBOARD_ACCESS_TOKEN;

const assert = require('assert');
const { getConfig } = require('../lib/config');
const D = require('../lib/dates');
const { toCents, formatMoney, balanceCents } = require('../lib/money');
const { esc, normEmail, normPhone } = require('../lib/util');
const { parseCsv, csvToInvoices } = require('../lib/csv');
const R = require('../lib/replytext');
const C = require('../lib/classify');
const S = require('../lib/sequence');
const { decide } = require('../lib/policy');
const T = require('../lib/templates');
const { computeMetrics, attentionList } = require('../lib/metrics');
const tokens = require('../lib/tokens');
const auth = require('../lib/auth');

let passed = 0; const failures = [];
const test = (name, fn) => { try { fn(); passed++; } catch (e) { failures.push(`✗ ${name}\n    ${e.message.split('\n')[0]}`); } };
const eq = assert.deepStrictEqual;

const cfg = getConfig({ BUSINESS_NAME: 'Acme Co', BUSINESS_TIMEZONE: 'America/New_York', PAYMENT_INSTRUCTIONS: 'ACH to 000-111\\nRef: invoice number', LATE_FEE_NOTE: 'A 1.5% monthly late fee applies.' });
const TODAY = '2026-09-30', NOW = new Date('2026-09-30T15:00:00Z'), NOW_ISO = NOW.toISOString();   // a Wednesday, 11:00 in New York

// ---------- dates ----------
test('daysBetween / addDays / endOfMonth', () => {
  eq(D.daysBetween('2026-09-01', '2026-09-30'), 29);
  eq(D.addDays('2026-12-30', 3), '2027-01-02');
  eq(D.endOfMonth('2026-02-10'), '2026-02-28'); eq(D.endOfMonth('2028-02-10'), '2028-02-29');
});
test('weekdayOf / mondayOf', () => { eq(D.weekdayOf('2026-09-30'), 'Wed'); eq(D.mondayOf('2026-09-30'), '2026-09-28'); eq(D.mondayOf('2026-10-04'), '2026-09-28'); });
test('todayISO respects the timezone', () => {
  eq(D.todayISO('America/New_York', new Date('2026-10-01T02:30:00Z')), '2026-09-30');
  eq(D.todayISO('Europe/Paris', new Date('2026-10-01T02:30:00Z')), '2026-10-01');
});
test('inSendWindow', () => {
  eq(D.inSendWindow(new Date('2026-09-30T15:00:00Z'), cfg), true);   // Wed 11:00 NY
  eq(D.inSendWindow(new Date('2026-09-30T23:00:00Z'), cfg), false);  // Wed 19:00
  eq(D.inSendWindow(new Date('2026-10-03T15:00:00Z'), cfg), false);  // Saturday
});
test('parseDateLoose reads real-world formats', () => {
  eq(D.parseDateLoose('09/30/2026', 'en-US'), '2026-09-30'); eq(D.parseDateLoose('30/09/2026', 'en-GB'), '2026-09-30');
  eq(D.parseDateLoose('25/12/2026', 'en-US'), '2026-12-25'); eq(D.parseDateLoose('Sep 30, 2026'), '2026-09-30');
  eq(D.parseDateLoose('30 September 2026'), '2026-09-30'); eq(D.parseDateLoose('2026-9-3'), '2026-09-03');
  eq(D.parseDateLoose('2026-02-30'), null); eq(D.parseDateLoose('soon'), null);
});

// ---------- money / util ----------
test('toCents handles currency symbols and decimal commas', () => {
  eq(toCents('$1,234.50'), 123450); eq(toCents('1.234,56'), 123456); eq(toCents('1234,5'), 123450); eq(toCents(12.5), 1250); eq(toCents('abc'), null); eq(toCents(''), null);
});
test('formatMoney / balanceCents', () => { eq(formatMoney(125000, 'USD', 'en-US'), '$1,250.00'); eq(balanceCents({ amount_cents: 1000, amount_paid_cents: 400 }), 600); eq(balanceCents({ amount_cents: 1000, amount_paid_cents: 1500 }), 0); });
test('normPhone / normEmail / esc', () => {
  eq(normPhone('(555) 123-4567'), '+15551234567'); eq(normPhone('+33 6 12 34 56 78'), '+33612345678'); eq(normEmail(' A@B.com '), 'a@b.com'); eq(normEmail('nope'), null);
  eq(esc('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
});

// ---------- csv ----------
test('csv: quotes, commas, balance column', () => {
  const r = csvToInvoices('Invoice #,Client,Email,Total,Balance Due,Due Date\r\nINV-1,"Acme, Inc.",ap@acme.com,"$1,000.00",$400.00,09/01/2026\r\n');
  eq(r.rows.length, 1);
  const x = r.rows[0];
  eq([x.invoice_number, x.customer_name, x.customer_email, x.amount_cents, x.amount_paid_cents, x.due_date], ['INV-1', 'Acme, Inc.', 'ap@acme.com', 100000, 60000, '09/01/2026']);
});
test('csv: semicolons and a balance-only sheet', () => {
  eq(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  const r = csvToInvoices('Number;Customer;Amount Due;Due\nA1;Zed;250,00;2026-09-01');
  eq([r.rows[0].amount_cents, r.rows[0].amount_paid_cents], [25000, 0]);
});
test('csv: re-importing without a paid column does not erase partial payments', () => {
  const r = csvToInvoices('Invoice,Customer,Total,Due\nA1,Zed,100,2026-09-01');
  eq(r.rows[0].amount_paid_cents, undefined);
});

// ---------- reply text ----------
test('stripQuoted: Gmail, wrapped, Outlook, bottom-posted, signature', () => {
  eq(R.stripQuoted('Will pay Friday, thanks.\n\nOn Tue, Sep 29, 2026 at 9:14 AM Acme Accounts <chaser@gmail.com> wrote:\n> reminder text'), 'Will pay Friday, thanks.');
  eq(R.stripQuoted('Paid on the 3rd.\n\nOn Tue, Sep 29, 2026 at 9:14 AM Acme Accounts\n<chaser@gmail.com> wrote:\n> x'), 'Paid on the 3rd.');
  eq(R.stripQuoted('We dispute this.\n\nFrom: Acme\nSent: Tuesday\nTo: x\nSubject: Re: INV-1'), 'We dispute this.');
  eq(R.stripQuoted('> Hi Jo, reminder\n\nWe will pay on Friday.'), 'We will pay on Friday.');
  eq(R.stripQuoted('Thanks\n-- \nJo Smith, AP'), 'Thanks');
});
test('auto-reply, bounce, subject cleaning', () => {
  eq(R.isAutoReply({ subject: 'Automatic reply: Out of office', headers: {}, from: 'a@b.com' }), true);
  eq(R.isAutoReply({ subject: 'Re: INV-1', headers: { autoSubmitted: 'auto-replied' }, from: 'a@b.com' }), true);
  eq(R.isAutoReply({ subject: 'Re: INV-1', headers: { autoSubmitted: 'no' }, from: 'a@b.com' }), false);
  eq(R.isAutoReply({ subject: 'Re: INV-1', headers: {}, from: 'noreply@b.com' }), true);
  eq(R.isBounce({ from: 'MAILER-DAEMON@googlemail.com', subject: 'Delivery Status Notification (Failure)' }), true);
  eq(R.cleanSubject('Re: RE: Fwd: Invoice INV-1'), 'Invoice INV-1');
  eq(R.extractEmails('write to AP@Acme.com or ap@acme.com, thanks'), ['ap@acme.com']);
});

// ---------- classify helpers ----------
test('safetyScan catches legal, bankruptcy, stop — and not "Sue"', () => {
  eq(C.safetyScan('I will call my lawyer about this'), 'legal'); eq(C.safetyScan('we filed for Chapter 11'), 'bankruptcy');
  eq(C.safetyScan('Please stop emailing me'), 'stop'); eq(C.safetyScan('Thanks, Sue'), null); eq(C.safetyScan('We will pay on Friday'), null);
});
test('normalize forces model output into a safe shape', () => {
  const n = C.normalize({ intent: 'bogus', confidence: 5, promised_date: '2026-02-30', summary: '', partial_amount: -3, new_contact_email: 'not an email', sentiment: 'furious' });
  eq([n.intent, n.confidence, n.promised_date, n.summary, n.partial_amount, n.new_contact_email, n.sentiment], ['other', 1, null, 'No summary available.', null, null, 'neutral']);
  const ok = C.normalize({ intent: 'promise_to_pay', confidence: 0.9, promised_date: '2026-10-02', invoice_numbers: ['INV-1'], new_contact_email: 'AP@X.com' });
  eq([ok.intent, ok.promised_date, ok.invoice_numbers, ok.new_contact_email], ['promise_to_pay', '2026-10-02', ['INV-1'], 'ap@x.com']);
});
test('parseJson survives code fences and chatter', () => {
  const F = '`'.repeat(3);
  eq(C.parseJson(`${F}json\n{"a":1}\n${F}`), { a: 1 }); eq(C.parseJson('Sure! {"a":2} hope that helps'), { a: 2 }); eq(C.parseJson('nope'), null);
});
test('calendarHint gives the model a real calendar', () => {
  const h = C.calendarHint('2026-09-30');
  assert(h.includes('Fri 2026-10-02') && h.includes('Last day of this month: 2026-09-30') && h.includes('2026-10-31'));
});

// ---------- sequence ----------
const cust = (o = {}) => ({ id: 'c1', name: 'Acme', contact_name: 'Jo Smith', email: 'ap@acme.com', do_not_contact: false, email_bounced: false, last_contacted_at: null, ...o });
const inv = (o = {}) => ({ id: 'i1', invoice_number: 'INV-1', amount_cents: 100000, amount_paid_cents: 0, currency: 'USD', status: 'open', due_date: '2026-09-29', reminder_count: 0, last_reminder_at: null, promised_date: null, promised_count: 0, broken_promise_at: null, paused_until: null, customers: cust(), ...o });
const ctx = { today: TODAY, now: NOW, cfg };

test('sequence: 1 day late -> friendly; not late yet -> nothing', () => {
  eq(S.stepFor(inv(), ctx).tone, 'friendly'); eq(S.stepFor(inv({ due_date: '2026-09-30' }), ctx), null); eq(S.stepFor(inv({ due_date: '2026-10-10' }), ctx), null);
});
test('sequence: an old, never-chased invoice starts gently, not with a final notice', () => {
  const s = S.stepFor(inv({ due_date: '2026-08-01' }), ctx); eq([s.tone, s.index], ['friendly', 0]);
});
test('sequence: min gap between reminders, then the next step', () => {
  eq(S.stepFor(inv({ due_date: '2026-09-01', reminder_count: 1, last_reminder_at: '2026-09-27T14:00:00Z' }), ctx), null);
  eq(S.stepFor(inv({ due_date: '2026-09-01', reminder_count: 1, last_reminder_at: '2026-09-20T14:00:00Z' }), ctx).tone, 'follow_up');
});
test('sequence: paid, zero balance, paused invoices are never chased', () => {
  eq(S.stepFor(inv({ status: 'paid' }), ctx), null); eq(S.stepFor(inv({ amount_paid_cents: 100000 }), ctx), null);
  eq(S.stepFor(inv({ status: 'disputed' }), ctx), null); eq(S.stepFor(inv({ status: 'payment_claimed' }), ctx), null);
});
test('sweeps: broken promise, expired hold, exhausted sequence', () => {
  const list = [
    inv({ id: 'p', status: 'promised', promised_date: '2026-09-25' }), inv({ id: 'ok', status: 'promised', promised_date: '2026-09-29' }),
    inv({ id: 'h', status: 'on_hold', paused_until: '2026-09-29T00:00:00Z' }), inv({ id: 'h2', status: 'on_hold', paused_until: '2026-10-05T00:00:00Z' }), inv({ id: 'hn', status: 'on_hold', paused_until: null }),
    inv({ id: 'e', reminder_count: 4, last_reminder_at: '2026-09-20T14:00:00Z' }), inv({ id: 'e2', reminder_count: 4, last_reminder_at: '2026-09-27T14:00:00Z' })
  ];
  eq(S.planSweeps(list, ctx).map(s => `${s.type}:${s.invoiceId}`), ['promise_broken:p', 'resume:h', 'escalate:e']);
});
test('broken promise -> a "broken_promise" reminder after the sweep', () => {
  const i = inv({ status: 'promised', promised_date: '2026-09-25', last_reminder_at: '2026-09-18T14:00:00Z' });
  Object.assign(i, S.sweepPatch('promise_broken', NOW_ISO));
  const s = S.stepFor(i, ctx); eq([s.tone, s.index], ['broken_promise', null]);
});
test('planSends: groups same-step invoices, skips do-not-contact, respects customer gap', () => {
  const a = inv({ id: 'a', invoice_number: 'INV-A' }), b = inv({ id: 'b', invoice_number: 'INV-B' });
  const dnc = inv({ id: 'd', customers: cust({ id: 'c2', do_not_contact: true }) });
  const recent = inv({ id: 'r', customers: cust({ id: 'c3', last_contacted_at: '2026-09-28T14:00:00Z' }) });
  const bounced = inv({ id: 'x', customers: cust({ id: 'c4', email_bounced: true }) });
  const p = S.planSends([a, b, dnc, recent, bounced], ctx);
  eq(p.sends.length, 1); eq(p.sends[0].invoices.map(i => i.id), ['a', 'b']);
  eq(p.skipped.map(s => s.reason).sort(), ['customer_contacted_recently', 'do_not_contact', 'email_bounced']);
});
test('planSends: a customer with invoices at different stages gets only the most advanced one', () => {
  const young = inv({ id: 'y' });
  const old = inv({ id: 'o', due_date: '2026-09-01', reminder_count: 1, last_reminder_at: '2026-09-10T14:00:00Z' });
  const p = S.planSends([young, old], ctx);
  eq(p.sends.length, 1); eq(p.sends[0].invoices.map(i => i.id), ['o']); eq(p.sends[0].step.tone, 'follow_up');
});

// ---------- policy ----------
const pctx = (o = {}) => ({
  cls: C.normalize({ intent: 'other', confidence: 0.9 }), safety: null, customer: cust(), senderKnown: true, cfg, today: TODAY, nowISO: NOW_ISO,
  targets: [inv({ id: 'i1', due_date: '2026-09-15' })], allActive: [inv({ id: 'i1' }), inv({ id: 'i2', invoice_number: 'INV-2' })], ...o
});
const cls = o => C.normalize({ confidence: 0.9, sentiment: 'neutral', ...o });

test('policy: a promise with a date pauses chasing and sends the fixed ack', () => {
  const d = decide(pctx({ cls: cls({ intent: 'promise_to_pay', promised_date: '2026-10-02' }) }));
  eq(d.label, 'promise_recorded'); eq(d.patches[0].patch.status, 'promised'); eq(d.patches[0].patch.promised_date, '2026-10-02'); eq(d.ack, { kind: 'promise_ack', date: '2026-10-02' }); eq(d.alert, null);
});
test('policy: unusable promise dates are not believed', () => {
  eq(decide(pctx({ cls: cls({ intent: 'promise_to_pay', promised_date: '2026-09-20' }) })).label, 'promise_no_date');
  eq(decide(pctx({ cls: cls({ intent: 'promise_to_pay', promised_date: '2026-12-30' }) })).label, 'promise_no_date');
  eq(decide(pctx({ cls: cls({ intent: 'promise_to_pay', promised_date: null }) })).label, 'promise_no_date');
});
test('policy: the third promise goes to a human', () => {
  const d = decide(pctx({ cls: cls({ intent: 'promise_to_pay', promised_date: '2026-10-02' }), targets: [inv({ promised_count: 2 })] }));
  eq(d.label, 'promise_repeat'); eq(d.alert.level, 'action'); eq(d.alert.actions[0].action, 'set_promise');
});
test('policy: dispute stops chasing and alerts urgently', () => {
  const d = decide(pctx({ cls: cls({ intent: 'dispute', dispute_reason: 'Work not finished' }) }));
  eq([d.label, d.patches[0].patch.status, d.alert.level, d.ack], ['disputed', 'disputed', 'urgent', null]);
});
test('policy: "already paid" never marks paid by itself', () => {
  const d = decide(pctx({ cls: cls({ intent: 'already_paid', paid_date: '2026-09-28', payment_method: 'ACH' }) }));
  eq(d.patches[0].patch.status, 'payment_claimed'); eq(d.ack.kind, 'paid_ack'); eq(d.alert.actions.map(a => a.action), ['mark_paid', 'resume']);
});
test('policy: low confidence changes nothing except a short hold + alert', () => {
  const d = decide(pctx({ cls: cls({ intent: 'promise_to_pay', promised_date: '2026-10-02', confidence: 0.4 }) }));
  eq([d.label, d.patches[0].patch.status, d.ack], ['low_confidence', 'on_hold', null]);
});
test('policy: unknown senders cannot change anything', () => {
  const d = decide(pctx({ senderKnown: false, cls: cls({ intent: 'dispute' }) })); eq([d.label, d.patches.length, d.alert.level], ['unverified_sender', 0, 'action']);
});
test('policy: legal / bankruptcy / stop requests freeze ALL of the customer\'s invoices', () => {
  const d = decide(pctx({ safety: 'legal', cls: cls({ intent: 'acknowledged' }) }));
  eq([d.label, d.customerPatch, d.patches.length, d.alert.level], ['stopped_legal', { do_not_contact: true }, 2, 'urgent']);
  eq(decide(pctx({ safety: 'bankruptcy' })).label, 'stopped_legal'); eq(decide(pctx({ safety: 'stop' })).label, 'stopped_by_request');
});
test('policy: extension offers an approve button only for a sensible date', () => {
  const d = decide(pctx({ cls: cls({ intent: 'extension_request', promised_date: '2026-10-15' }) }));
  eq(d.alert.actions.map(a => a.action), ['set_promise', 'resume']);
  eq(decide(pctx({ cls: cls({ intent: 'extension_request', promised_date: null }) })).alert.actions.map(a => a.action), ['resume']);
});
test('policy: wrong contact offers to switch the address; no-op cases behave', () => {
  eq(decide(pctx({ cls: cls({ intent: 'wrong_contact', new_contact_email: 'ap@new.com' }) })).alert.actions[0].params, { email: 'ap@new.com' });
  eq(decide(pctx({ targets: [] })).label, 'no_open_invoices');
  const ack = decide(pctx({ cls: cls({ intent: 'acknowledged' }) })); eq([ack.label, ack.patches.length, ack.alert], ['acknowledged', 0, null]);
  eq(decide(pctx({ cls: cls({ intent: 'other' , sentiment: 'hostile' }) })).label, 'hostile');
});
test('policy: invoice copy is auto-sent only when a link is stored', () => {
  eq(decide(pctx({ cls: cls({ intent: 'needs_invoice_copy' }) })).alert.level, 'action');
  eq(decide(pctx({ cls: cls({ intent: 'needs_invoice_copy' }), targets: [inv({ invoice_url: 'https://x.test/i/1' })] })).ack, { kind: 'invoice_copy' });
});

// ---------- templates ----------
test('templates: single, multiple, tones, escaping', () => {
  const one = T.renderReminder({ tone: 'friendly', customer: cust(), invoices: [inv({ due_date: '2026-09-15', invoice_url: 'https://pay.test/1' })], cfg, today: TODAY });
  assert(one.subject.includes('INV-1') && one.text.includes('Hi Jo,') && one.text.includes('$1,000.00') && one.text.includes('Sep 15, 2026') && one.text.includes('ACH to 000-111') && one.html.includes('<table'));
  const many = T.renderReminder({ tone: 'firm', customer: cust({ contact_name: null }), invoices: [inv({ id: 'a' }), inv({ id: 'b', invoice_number: 'INV-2' })], cfg, today: TODAY });
  assert(many.subject.includes('2 invoices') && many.text.startsWith('Hello,') && many.text.includes('late fee'));
  const fin = T.renderReminder({ tone: 'final', customer: cust(), invoices: [inv()], cfg, today: TODAY }); assert(fin.subject.startsWith('Final reminder'));
  const bp = T.renderReminder({ tone: 'broken_promise', customer: cust(), invoices: [inv({ promised_date: '2026-09-25' })], cfg, today: TODAY }); assert(bp.text.includes('Sep 25, 2026'));
  const xss = T.renderReminder({ tone: 'friendly', customer: cust(), invoices: [inv({ invoice_number: '<script>alert(1)</script>' })], cfg, today: TODAY }); assert(!xss.html.includes('<script>'));
});
test('templates: acknowledgements', () => {
  const a = T.renderAck({ kind: 'promise_ack', customer: cust(), invoices: [inv()], date: '2026-10-02', cfg, today: TODAY });
  assert(a.text.includes('Oct 2, 2026') && a.text.includes('INV-1'));
  assert(T.renderAck({ kind: 'invoice_copy', customer: cust(), invoices: [inv({ invoice_url: 'https://x.test' })], cfg, today: TODAY }).text.includes('https://x.test'));
});

// ---------- metrics ----------
test('metrics: aging buckets, totals, collected, attention list', () => {
  const list = [
    inv({ id: '1', due_date: '2026-10-05', amount_cents: 50000 }),                       // not yet due
    inv({ id: '2', due_date: '2026-09-20', amount_cents: 100000 }),                      // 10 late
    inv({ id: '3', due_date: '2026-08-01', amount_cents: 200000, status: 'disputed', status_note: 'wrong amount' }),   // 60 late
    inv({ id: '4', status: 'paid', paid_at: '2026-09-28T15:00:00Z', issue_date: '2026-09-01', due_date: '2026-09-15', amount_cents: 70000, amount_paid_cents: 70000 })
  ];
  const m = computeMetrics({ invoices: list, today: TODAY, cfg });
  eq([m.outstanding.cents, m.overdue.cents, m.aging.current.cents, m.aging.d1_30.cents, m.aging.d31_60.cents], [350000, 300000, 50000, 100000, 200000]);
  eq([m.collected.week.cents, m.avgDaysToPay, m.avgDaysLate], [70000, 27, 13]);
  eq(attentionList(list.filter(i => i.status !== 'paid'), TODAY).map(a => a.reason), ['disputed']);
});

// ---------- tokens / auth / config ----------
test('tokens: valid, tampered, expired', () => {
  const t = tokens.sign({ a: 'mark_paid', i: 'x' }); eq(tokens.verify(t).a, 'mark_paid');
  eq(tokens.verify(t.slice(0, -2) + 'xx'), null); eq(tokens.verify(tokens.sign({ a: 'x' }, -1)), null); eq(tokens.verify('garbage'), null);
});
test('auth: an unset or short secret never lets anyone in', () => {
  eq(auth.isDashboardAuthorized({ headers: {} }), false);
  process.env.DASHBOARD_ACCESS_TOKEN = 'short'; eq(auth.isDashboardAuthorized({ headers: { authorization: 'Bearer short' } }), false);
  process.env.DASHBOARD_ACCESS_TOKEN = 'a-long-enough-token-1234'; eq(auth.isDashboardAuthorized({ headers: { authorization: 'Bearer a-long-enough-token-1234' } }), true);
  eq(auth.isDashboardAuthorized({ headers: { authorization: 'Bearer wrong-wrong-wrong-wrong' } }), false);
  delete process.env.DASHBOARD_ACCESS_TOKEN;
});
test('config: defaults are safe, SEQUENCE_JSON is validated', () => {
  const c = getConfig({}); eq([c.dryRun, c.sequence.length, c.minGapDays], [true, 4, 5]);
  eq(getConfig({ DRY_RUN: 'false' }).dryRun, false);
  eq(getConfig({ SEQUENCE_JSON: '[{"offsetDays":3,"tone":"friendly"},{"offsetDays":10,"tone":"final"}]' }).sequence.map(s => s.offsetDays), [3, 10]);
  eq(getConfig({ SEQUENCE_JSON: 'not json' }).sequence.length, 4);
});

console.log(failures.length ? failures.join('\n') : '');
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);