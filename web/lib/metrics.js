// Every number on the dashboard and in the weekly report comes from here. Pure functions: rows in, numbers out.
const { daysBetween, addDays, todayISO } = require('./dates');
const { balanceCents } = require('./money');

const OPEN = ['open', 'promised', 'payment_claimed', 'disputed', 'on_hold', 'escalated'];
const BUCKETS = [['current', 'Not yet due'], ['d1_30', '1–30 days late'], ['d31_60', '31–60 days late'], ['d61_90', '61–90 days late'], ['d90plus', 'Over 90 days late']];
const bucketOf = late => (late <= 0 ? 'current' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : late <= 90 ? 'd61_90' : 'd90plus');
const avg = arr => (arr.length ? Math.round(arr.reduce((s, x) => s + x, 0) / arr.length) : null);

// `invoices` = every open invoice plus the ones paid in the last ~100 days, each with customers(name).
function computeMetrics({ invoices, today, cfg }) {
  const cur = cfg.business.currency, tz = cfg.business.timezone;
  const inCur = i => (i.currency || cur) === cur;
  const open = invoices.filter(i => OPEN.includes(i.status));
  const openCur = open.filter(inCur);
  const paid = invoices.filter(i => i.status === 'paid' && i.paid_at && inCur(i));

  const m = {
    asOf: today, currency: cur, otherCurrencyInvoices: open.length - openCur.length,
    outstanding: { cents: 0, count: 0 }, overdue: { cents: 0, count: 0 }, newlyOverdue: { cents: 0, count: 0 },
    aging: Object.fromEntries(BUCKETS.map(([k, label]) => [k, { label, cents: 0, count: 0 }])),
    byStatus: {}, collected: { week: { cents: 0, count: 0 }, month: { cents: 0, count: 0 } },
    avgDaysToPay: null, avgDaysLate: null, promisedNext7: [], dueNext7: [], topOverdue: []
  };

  const byCustomer = new Map();
  for (const i of openCur) {
    const bal = balanceCents(i), late = daysBetween(i.due_date, today);
    const name = (i.customers && i.customers.name) || 'Unknown';
    m.outstanding.cents += bal; m.outstanding.count++;
    const b = m.aging[bucketOf(late)]; b.cents += bal; b.count++;
    const s = (m.byStatus[i.status] = m.byStatus[i.status] || { cents: 0, count: 0 }); s.cents += bal; s.count++;
    if (late > 0) {
      m.overdue.cents += bal; m.overdue.count++;
      if (late <= 7) { m.newlyOverdue.cents += bal; m.newlyOverdue.count++; }
      const c = byCustomer.get(name) || { customer: name, cents: 0, count: 0, oldest: 0 };
      c.cents += bal; c.count++; c.oldest = Math.max(c.oldest, late); byCustomer.set(name, c);
    }
    if (i.status === 'promised' && i.promised_date) {
      const away = daysBetween(today, i.promised_date);
      if (away >= 0 && away <= 7) m.promisedNext7.push({ customer: name, invoice: i.invoice_number, cents: bal, date: i.promised_date });
    }
    if (i.status === 'open' && late <= 0 && late >= -7) m.dueNext7.push({ customer: name, invoice: i.invoice_number, cents: bal, date: i.due_date });
  }
  m.topOverdue = [...byCustomer.values()].sort((a, b) => b.cents - a.cents).slice(0, 5);
  m.promisedNext7.sort((a, b) => a.date.localeCompare(b.date));
  m.dueNext7.sort((a, b) => a.date.localeCompare(b.date));

  const weekFrom = addDays(today, -6), monthFrom = addDays(today, -29), ninetyFrom = addDays(today, -90);
  const toPay = [], daysLate = [];
  for (const i of paid) {
    const paidISO = todayISO(tz, new Date(i.paid_at));
    const cents = Number(i.amount_paid_cents) || Number(i.amount_cents);
    if (paidISO >= weekFrom) { m.collected.week.cents += cents; m.collected.week.count++; }
    if (paidISO >= monthFrom) { m.collected.month.cents += cents; m.collected.month.count++; }
    if (paidISO >= ninetyFrom) {
      if (i.issue_date) toPay.push(daysBetween(i.issue_date, paidISO));
      daysLate.push(Math.max(0, daysBetween(i.due_date, paidISO)));
    }
  }
  m.avgDaysToPay = avg(toPay);
  m.avgDaysLate = avg(daysLate);
  return m;
}

const PRIORITY = { disputed: 0, escalated: 1, payment_claimed: 2, on_hold: 3, no_contact: 4 };

// The "needs you" list: everything the automation has handed to a human.
function attentionList(invoices, today) {
  const out = [];
  for (const i of invoices) {
    if (!OPEN.includes(i.status)) continue;
    const c = i.customers || {};
    let reason = null;
    if (['disputed', 'escalated', 'payment_claimed', 'on_hold'].includes(i.status)) reason = i.status;
    else if (i.status === 'open' && (c.do_not_contact || c.email_bounced)) reason = 'no_contact';
    if (!reason) continue;
    out.push({
      id: i.id, customerId: i.customer_id, invoice: i.invoice_number, customer: c.name || 'Unknown', cents: balanceCents(i),
      late: daysBetween(i.due_date, today), reason,
      note: i.status_note || (reason === 'no_contact' ? (c.do_not_contact ? 'Do not contact' : 'Email bounced') : '')
    });
  }
  return out.sort((a, b) => PRIORITY[a.reason] - PRIORITY[b.reason] || b.late - a.late);
}

module.exports = { OPEN, BUCKETS, computeMetrics, attentionList };