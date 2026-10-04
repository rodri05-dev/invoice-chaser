const { isDashboardAuthorized } = require('../lib/auth');
const { supabase } = require('../lib/db');
const { getConfig } = require('../lib/config');
const { daysBetween } = require('../lib/dates');
const { balanceCents } = require('../lib/money');
const { computeMetrics, attentionList } = require('../lib/metrics');
const { loadData } = require('../lib/report');

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

    const [replies, events, jobs] = await Promise.all([
      supabase.from('inbound_messages').select('id, channel, from_address, subject, body_text, intent, confidence, ai_result, needs_human, action_taken, kind, created_at, customers(name)').order('created_at', { ascending: false }).limit(30),
      supabase.from('events').select('type, details, created_at, invoices(invoice_number), customers(name)').order('created_at', { ascending: false }).limit(60),
      supabase.from('jobs').select('job, last_run_at, last_ok, last_summary')
    ]);

    res.status(200).json({
      business: cfg.business.name, currency: cfg.business.currency, locale: cfg.business.locale,
      dryRun: cfg.dryRun, testOverride: !!cfg.testEmailOverride, today,
      metrics, attention, invoices, stats,
      replies: replies.data || [], events: events.data || [], jobs: jobs.data || []
    });
  } catch (e) {
    console.error('dashboard-data failed:', e);
    res.status(500).json({ error: e.message });
  }
};