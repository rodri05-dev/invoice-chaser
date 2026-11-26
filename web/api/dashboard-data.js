const { isDashboardAuthorized } = require('../lib/auth');
const { supabase } = require('../lib/db');
const { getConfig } = require('../lib/config');
const { daysBetween, todayISO } = require('../lib/dates');
const { balanceCents } = require('../lib/money');
const { computeMetrics, attentionList } = require('../lib/metrics');
const { loadData } = require('../lib/report');
const { usageSummary } = require('../lib/aiusage');
const { INFO, labelOf, categoryOf } = require('../lib/disputes');

const OPEN_TASKS = ['open', 'waiting_on_customer', 'credit_note_needed'];

module.exports = async (req, res) => {
  if (!isDashboardAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const cfg = getConfig();
    const { today, open, paid, stats } = await loadData(cfg);
    const metrics = computeMetrics({ invoices: [...open, ...paid], today, cfg });
    const attention = attentionList(open, today);
    const invoices = open.map(i => ({
      id: i.id, customerId: i.customer_id, number: i.invoice_number, customer: i.customers && i.customers.name, email: i.customers && i.customers.email,
      status: i.status, note: i.status_note, cents: balanceCents(i), currency: i.currency, due: i.due_date, late: daysBetween(i.due_date, today),
      reminders: i.reminder_count, lastReminder: i.last_reminder_at, promised: i.promised_date, url: i.invoice_url
    })).sort((a, b) => b.late - a.late).slice(0, 500);

    const [replies, events, jobs, ai, tasks] = await Promise.all([
      supabase.from('inbound_messages').select('id, channel, from_address, subject, body_text, intent, confidence, ai_result, needs_human, action_taken, kind, created_at, customers(name)').order('created_at', { ascending: false }).limit(30),
      supabase.from('events').select('type, details, created_at, invoices(invoice_number), customers(name)').order('created_at', { ascending: false }).limit(60),
      supabase.from('jobs').select('job, last_run_at, last_ok, last_summary'),
      usageSummary(),                                 // today's AI tokens; null if the ai_usage table is missing
      supabase.from('tasks').select('id, invoice_id, customer_id, category, status, assignee_email, note, due_date, created_at, invoices(invoice_number, amount_cents, amount_paid_cents, amount_credited_cents, currency)s, currency), customers(name)')
        .in('status', OPEN_TASKS).order('created_at')          // {data:null} if the tasks table is not there yet: the tab just stays empty
    ]);

    const disputes = (tasks.data || []).map(t => {
      const cat = categoryOf(t.category), inv = t.invoices || {};
      return {
        id: t.id, invoiceId: t.invoice_id, customerId: t.customer_id, customer: (t.customers && t.customers.name) || 'Unknown', invoice: inv.invoice_number,
        cents: balanceCents(inv), reason: labelOf(cat), collect: INFO[cat].collect, status: t.status, note: t.note, assignee: t.assignee_email,
        ageDays: Math.max(0, daysBetween(todayISO(cfg.business.timezone, new Date(t.created_at)), today))
      };
    });

    res.status(200).json({
      business: cfg.business.name, currency: cfg.business.currency, locale: cfg.business.locale,
      dryRun: cfg.dryRun, testOverride: !!cfg.testEmailOverride, today,
      metrics, attention, invoices, stats, ai, disputes,
      replies: replies.data || [], events: events.data || [], jobs: jobs.data || []
    });
  } catch (e) {
    console.error('dashboard-data failed:', e);
    res.status(500).json({ error: e.message });
  }
};