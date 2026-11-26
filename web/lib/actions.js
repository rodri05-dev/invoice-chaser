// Everything the owner can do to an invoice, in one place. The dashboard buttons and the
// "one-click" links in alert emails both call performAction(), so they can never disagree.
const { supabase, must, logEvent } = require('./db');
const { isValidISODate } = require('./dates');
const { toCents } = require('./money');
const { normEmail } = require('./util');
const { updateTasks } = require('./tasks');

const ACTIONS = ['mark_paid', 'resume', 'snooze', 'stop', 'void', 'set_promise', 'partial_payment', 'set_contact', 'allow_contact', 'evidence_sent', 'credit_note_needed'];

async function performAction({ action, invoiceId = null, customerId = null, params = {}, actor = 'owner' }) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action: ${action}`);
  const nowISO = new Date().toISOString();

  // ---- customer-level actions ----
  if (action === 'allow_contact') {
    if (!customerId) throw new Error('customerId required');
    must(await supabase.from('customers').update({ do_not_contact: false }).eq('id', customerId));
    await logEvent({ customerId, type: 'allow_contact', details: { actor } });
    return { ok: true };
  }
  if (action === 'set_contact') {
    const email = normEmail(params.email);
    if (!customerId || !email) throw new Error('A customer and a valid email are required');
    const clash = must(await supabase.from('customers').select('id').eq('email', email).neq('id', customerId).limit(1));
    if (clash.length) throw new Error('Another customer already uses that email address');
    const cust = must(await supabase.from('customers').select('email, extra_emails').eq('id', customerId).single());
    const extra = [...new Set([...(cust.extra_emails || []), ...(cust.email ? [cust.email] : [])])];   // keep accepting replies from the old address
    must(await supabase.from('customers').update({ email, extra_emails: extra, email_bounced: false }).eq('id', customerId));
    must(await supabase.from('invoices').update({ status: 'open', paused_until: null, status_note: null })
      .eq('customer_id', customerId).eq('status', 'on_hold').like('status_note', 'Wrong contact%'));
    await logEvent({ customerId, type: 'set_contact', details: { actor, email } });
    return { ok: true };
  }

  // ---- invoice-level actions ----
  const inv = must(await supabase.from('invoices').select('*').eq('id', invoiceId).maybeSingle());
  if (!inv) throw new Error('Invoice not found');
  if (['paid', 'void'].includes(inv.status) && !['mark_paid', 'void'].includes(action)) throw new Error(`This invoice is already ${inv.status}`);
  let patch, type = action;

  switch (action) {
    case 'mark_paid':
      // Cash paid = the total minus any credit notes. Credit notes are not cash, so they never count as money collected.
      patch = { status: 'paid', paid_at: params.paid_at || nowISO, amount_paid_cents: Math.max(0, Number(inv.amount_cents) - Number(inv.amount_credited_cents || 0)), status_note: null, paused_until: null };
      break;
    case 'resume':
      patch = { status: 'open', paused_until: null, status_note: null };
      if (inv.status === 'escalated') patch.last_reminder_at = nowISO;   // otherwise it would be escalated again on the very next run
      break;
    case 'snooze': {
      const days = Math.min(90, Math.max(1, Number(params.days) || 7));
      patch = { status: 'on_hold', paused_until: new Date(Date.now() + days * 86400000).toISOString(), status_note: `Snoozed ${days} days by ${actor}` };
      break;
    }
    case 'stop':
      patch = { status: 'on_hold', paused_until: null, status_note: `Stopped by ${actor}` };
      break;
    case 'void':
      patch = { status: 'void', paused_until: null, status_note: null };
      break;
    case 'set_promise': {
      if (!isValidISODate(params.date)) throw new Error('A valid date (YYYY-MM-DD) is required');
      patch = { status: 'promised', promised_date: params.date, paused_until: null, broken_promise_at: null, status_note: `Payment expected by ${params.date} (set by ${actor})` };
      break;
    }
    case 'partial_payment': {
      const cents = toCents(params.amount);
      if (!cents || cents <= 0) throw new Error('A payment amount is required');
      const owed = Math.max(0, Number(inv.amount_cents) - Number(inv.amount_credited_cents || 0));   // the most cash that can still come in
      const paid = Math.min(owed, Number(inv.amount_paid_cents) + cents);
      const closes = paid >= owed;
      patch = closes ? { status: 'paid', paid_at: nowISO, amount_paid_cents: paid, status_note: null } : { amount_paid_cents: paid };
      type = closes ? 'mark_paid' : 'partial_payment';
      break;
    }
    // The two dispute notes. The invoice stays "disputed", so chasing stays paused until you decide.
    case 'evidence_sent':
      if (inv.status !== 'disputed') throw new Error('This invoice is not in dispute');
      patch = { status_note: 'Evidence sent to the customer. Waiting for their answer.' };
      break;
    case 'credit_note_needed':
      if (inv.status !== 'disputed') throw new Error('This invoice is not in dispute');
      patch = { status_note: 'Credit note needed. Raise it in your accounting software.' };
      break;
  }
  const updated = must(await supabase.from('invoices').update(patch).eq('id', invoiceId).select().single());
  await logEvent({ invoiceId, customerId: inv.customer_id, type, details: { actor, ...params } });

  // Keep the dispute task in step with what the owner just did (best effort: never blocks the action).
  if (action === 'evidence_sent') await updateTasks(invoiceId, 'waiting_on_customer', patch.status_note);
  else if (action === 'credit_note_needed') await updateTasks(invoiceId, 'credit_note_needed', patch.status_note);
  else if (action === 'void') await updateTasks(invoiceId, 'cancelled');
  else if (action === 'resume' || action === 'set_promise' || type === 'mark_paid') await updateTasks(invoiceId, 'resolved');
  return updated;
}

module.exports = { performAction, ACTIONS };