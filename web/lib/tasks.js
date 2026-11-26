// Dispute tasks: one open task per disputed invoice. Every function here is "best effort" for its caller:
// a missing table or a database hiccup is logged, but it can never break the real work (an alert or a button).
const { supabase, must } = require('./db');
const { addDays } = require('./dates');

const OPEN = ['open', 'waiting_on_customer', 'credit_note_needed'];

// Who should fix it: a rule for that reason if you set one, otherwise you (the owner).
async function assigneeFor(category, cfg) {
  try {
    const rows = must(await supabase.from('routing_rules').select('assignee_email').eq('category', category).limit(1));
    if (rows[0] && rows[0].assignee_email) return rows[0].assignee_email;
  } catch (e) { console.warn('tasks: routing lookup failed:', e.message); }
  return (cfg.business && cfg.business.ownerEmail) || null;
}

// Called when a customer disputes an invoice. A second dispute reply on the same invoice updates the
// task (and puts it back to "open", because the customer has answered) instead of making a second one.
async function openDisputeTask({ invoice, customer, category, note, cfg, today }) {
  try {
    const assignee = await assigneeFor(category, cfg);
    const due = addDays(today, cfg.disputeTaskDays || 5);
    const existing = must(await supabase.from('tasks').select('id').eq('invoice_id', invoice.id).eq('type', 'dispute').in('status', OPEN).limit(1));
    if (existing.length) {
      must(await supabase.from('tasks').update({ category, assignee_email: assignee, note, status: 'open', due_date: due }).eq('id', existing[0].id));
      return { updated: existing[0].id };
    }
    const row = must(await supabase.from('tasks').insert({ invoice_id: invoice.id, customer_id: customer.id, type: 'dispute', category, assignee_email: assignee, note, due_date: due }).select('id').single());
    return { created: row.id };
  } catch (e) {
    console.error('tasks: could not open the dispute task:', e.message);
    return { error: e.message };
  }
}

// Called by the owner's buttons. status: waiting_on_customer | credit_note_needed | resolved | cancelled
async function updateTasks(invoiceId, status, note) {
  try {
    const patch = { status, ...(note ? { note } : {}), ...(status === 'resolved' || status === 'cancelled' ? { resolved_at: new Date().toISOString() } : {}) };
    must(await supabase.from('tasks').update(patch).eq('invoice_id', invoiceId).in('status', OPEN));
    return { ok: true };
  } catch (e) {
    console.error('tasks: could not update the task:', e.message);
    return { error: e.message };
  }
}

module.exports = { OPEN, assigneeFor, openDisputeTask, updateTasks };