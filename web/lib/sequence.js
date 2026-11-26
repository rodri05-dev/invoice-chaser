// The brain of the reminder engine, written as PURE functions (no database, no email) so every
// rule can be tested on its own. chase.js is the thin layer that applies the plan for real.
const { daysBetween, daysSinceTs } = require('./dates');
const { balanceCents } = require('./money');

// Housekeeping that must happen before anything is sent.
function planSweeps(invoices, { today, now, cfg }) {
  const tz = cfg.business.timezone;
  const out = [];
  for (const inv of invoices) {
    if (inv.status === 'promised' && inv.promised_date && daysBetween(inv.promised_date, today) > cfg.promiseGraceDays) {
      out.push({ type: 'promise_broken', invoiceId: inv.id });                     // they said Friday; it is now Monday+
    } else if (inv.status === 'on_hold' && inv.paused_until && new Date(inv.paused_until) <= now) {
      out.push({ type: 'resume', invoiceId: inv.id });                              // a snooze / decision hold has expired
    } else if (inv.status === 'open' && (inv.reminder_count || 0) >= cfg.sequence.length && inv.last_reminder_at &&
               daysSinceTs(inv.last_reminder_at, today, tz) >= cfg.escalateGapDays) {
      out.push({ type: 'escalate', invoiceId: inv.id });                            // every step sent, still unpaid: a human takes over
    }
  }
  return out;
}

const sweepPatch = (type, nowISO) => ({
  promise_broken: { status: 'open', broken_promise_at: nowISO },
  resume: { status: 'open', paused_until: null, status_note: null },
  escalate: { status: 'escalated' }
}[type]);

// Is this invoice due for a reminder right now, and which one?
function stepFor(inv, { today, cfg }) {
  if (inv.status !== 'open' || balanceCents(inv) <= 0) return null;
  const brokenPending = inv.broken_promise_at && (!inv.last_reminder_at || new Date(inv.broken_promise_at) > new Date(inv.last_reminder_at));
  if (brokenPending) return { index: null, key: 'broken_promise', tone: 'broken_promise', sms: true, rank: 100 };

  const idx = inv.reminder_count || 0;
  const step = cfg.sequence[idx];
  if (!step) return null;
  if (daysBetween(inv.due_date, today) < step.offsetDays) return null;                                   // not late enough yet
  if (inv.last_reminder_at && daysSinceTs(inv.last_reminder_at, today, cfg.business.timezone) < cfg.minGapDays) return null;   // too soon after the last one
  return { index: idx, key: step.key, tone: step.tone, sms: step.sms, rank: idx };
}

// Who gets an email right now. One email per customer per run, grouping invoices that are at the same step.
function planSends(invoices, { today, cfg }) {
  const tz = cfg.business.timezone;
  const byCustomer = new Map();
  const skipped = [];

  for (const inv of invoices) {
    const step = stepFor(inv, { today, cfg });
    if (!step) continue;
    const c = inv.customers;
    const skip = reason => skipped.push({ invoice: inv.invoice_number, customer: c ? c.name : null, reason });
    if (!c) { skip('no_customer'); continue; }
    if (c.do_not_contact) { skip('do_not_contact'); continue; }
    if (c.email_bounced) { skip('email_bounced'); continue; }
    if (!c.email) { skip('no_email'); continue; }
    if (c.last_contacted_at && daysSinceTs(c.last_contacted_at, today, tz) < cfg.minGapDays) { skip('customer_contacted_recently'); continue; }
    if (!byCustomer.has(c.id)) byCustomer.set(c.id, []);
    byCustomer.get(c.id).push({ inv, step });
  }

  const sends = [];
  for (const entries of byCustomer.values()) {
    const top = Math.max(...entries.map(e => e.step.rank));          // if a customer has invoices at different stages, the most advanced goes first
    const chosen = entries.filter(e => e.step.rank === top);
    sends.push({
      customer: chosen[0].inv.customers,
      invoices: chosen.map(e => e.inv),
      step: chosen[0].step,
      totalCents: chosen.reduce((s, e) => s + balanceCents(e.inv), 0)
    });
  }
  sends.sort((a, b) => b.totalCents - a.totalCents);                 // biggest balances first if a run hits its cap
  return { sends, skipped };
}

module.exports = { planSweeps, sweepPatch, stepFor, planSends };