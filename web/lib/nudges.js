// A dispute task that sits too long gets a second alert (to YOU, never to the customer).
// Called from the chase run. A task whose invoice is no longer in dispute (paid, voided or resumed)
// is closed quietly instead of nagging.
const { supabase, must } = require('./db');
const { alertOwner } = require('./notify');
const { OPEN } = require('./tasks');
const { labelOf, disputeLines } = require('./disputes');
const { formatMoney, balanceCents } = require('./money');

const BUTTONS = [
  { label: 'Evidence sent', action: 'evidence_sent' },
  { label: 'Resolved — resume chasing', action: 'resume' },
  { label: 'Credit note needed', action: 'credit_note_needed' },
  { label: 'Mark paid', action: 'mark_paid' },
  { label: 'Void invoice', action: 'void' }
];
const WHERE_IT_STANDS = {
  open: 'Nobody has dealt with this dispute yet.',
  waiting_on_customer: 'You said the evidence was sent, and the customer has not answered.',
  credit_note_needed: 'You said a credit note is needed. Has it been raised in your accounting software?'
};

async function nudgeDisputeTasks({ cfg, nowISO = new Date().toISOString() }) {
  const days = cfg.disputeTaskDays || 5;
  let rows;
  try {
    rows = must(await supabase.from('tasks')
      .select('id, invoice_id, customer_id, category, status, note, created_at, updated_at, last_alert_at, invoices(id, invoice_number, status, amount_cents, amount_paid_cents, currency), customers(name)')
      .in('status', OPEN));
  } catch (e) { console.warn('nudges: could not read the tasks:', e.message); return { nudged: 0, closed: 0 }; }

  const now = Date.parse(nowISO);
  let nudged = 0, closed = 0;
  for (const t of rows) {
    const inv = t.invoices || {};
    if (inv.status && inv.status !== 'disputed') {                 // the dispute is over: close the task, say nothing
      must(await supabase.from('tasks').update({ status: inv.status === 'void' ? 'cancelled' : 'resolved', resolved_at: nowISO }).eq('id', t.id));
      closed++; continue;
    }
    const ms = v => (v ? Date.parse(v) || 0 : 0);
    const last = Math.max(ms(t.updated_at), ms(t.last_alert_at), ms(t.created_at));
    if ((now - last) / 86400000 < days) continue;
    const age = Math.max(days, Math.floor((now - ms(t.created_at)) / 86400000));
    const who = (t.customers && t.customers.name) || 'A customer';
    const amount = formatMoney(balanceCents(inv), inv.currency || cfg.business.currency, cfg.business.locale);
    await alertOwner({
      level: 'action', key: `task_nudge:${t.id}:${nowISO.slice(0, 10)}`, dedupeHours: 20,
      headline: `${who}: the dispute on ${inv.invoice_number} has waited ${age} days — ${labelOf(t.category)}`,
      lines: [`Invoice: ${inv.invoice_number} (${amount})`, WHERE_IT_STANDS[t.status] || '', ...(t.note ? [`Note: ${t.note}`] : []), ...disputeLines(t.category)],
      actions: BUTTONS, invoice: { id: t.invoice_id }, customer: { id: t.customer_id }
    });
    must(await supabase.from('tasks').update({ last_alert_at: nowISO }).eq('id', t.id));
    nudged++;
  }
  return { nudged, closed };
}

module.exports = { nudgeDisputeTasks, BUTTONS };