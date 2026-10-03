// The daily engine: housekeeping, then send whatever is due. Safe to run every 15 minutes.
const { supabase, must, fetchAll, logEvent } = require('./db');
const { getConfig } = require('./config');
const { todayISO, inSendWindow } = require('./dates');
const { planSweeps, sweepPatch, planSends } = require('./sequence');
const { renderReminder, renderSms } = require('./templates');
const { sendCustomerEmail, sendCustomerSms } = require('./outbound');
const { alertOwner } = require('./notify');
const { formatMoney, balanceCents } = require('./money');

async function runChase({ force = false, dryRun } = {}) {
  const cfg = getConfig();
  if (typeof dryRun === 'boolean') cfg.dryRun = dryRun;           // ?dry=1 on the URL overrides the env var
  const now = new Date();
  const nowISO = now.toISOString();
  const today = todayISO(cfg.business.timezone, now);
  if (!force && !inSendWindow(now, cfg)) return { skipped: 'outside_send_window', today };

  const invoices = await fetchAll(() =>
    supabase.from('invoices').select('*, customers(*)').in('status', ['open', 'promised', 'on_hold']).order('due_date').order('id'));
  const result = { today, dryRun: cfg.dryRun, checked: invoices.length, sweeps: 0, sent: 0, failed: 0, preview: [], skipped: [], sweepDetail: [] };
  const money = inv => formatMoney(balanceCents(inv), inv.currency || cfg.business.currency, cfg.business.locale);

  // 1) housekeeping: expired holds, broken promises, finished sequences
  for (const s of planSweeps(invoices, { today, now, cfg })) {
    const inv = invoices.find(i => i.id === s.invoiceId);
    const patch = sweepPatch(s.type, nowISO);
    Object.assign(inv, patch);                                      // the plan below sees the post-sweep state, even in a dry run
    result.sweeps++;
    result.sweepDetail.push({ type: s.type, invoice: inv.invoice_number, customer: inv.customers && inv.customers.name });
    if (cfg.dryRun) continue;

    must(await supabase.from('invoices').update(patch).eq('id', inv.id));
    await logEvent({ invoiceId: inv.id, customerId: inv.customer_id, type: s.type });
    const who = inv.customers ? inv.customers.name : 'Customer';
    if (s.type === 'escalate') {
      await alertOwner({
        level: 'action', key: `escalate:${inv.id}`, invoice: inv, customer: inv.customers,
        headline: `${who}: ${inv.invoice_number} needs a personal follow-up`,
        lines: [`All ${cfg.sequence.length} automatic reminders have gone out and ${money(inv)} is still unpaid.`, 'A phone call is the next step. Automatic chasing on this invoice has stopped.'],
        actions: [{ label: 'Snooze 7 days', action: 'snooze', params: { days: 7 } }, { label: 'Mark paid', action: 'mark_paid' }]
      }).catch(e => console.error(e.message));
    } else if (s.type === 'promise_broken') {
      await alertOwner({
        level: 'info', key: `broken:${inv.id}:${nowISO.slice(0, 10)}`, invoice: inv, customer: inv.customers,
        headline: `${who} didn't pay ${inv.invoice_number} by the date they promised (${inv.promised_date})`,
        lines: ['A follow-up reminder goes out at the next sending window.'],
        actions: [{ label: 'Snooze 7 days', action: 'snooze', params: { days: 7 } }, { label: 'Mark paid', action: 'mark_paid' }]
      }).catch(e => console.error(e.message));
    }
  }

  // 2) reminders
  const plan = planSends(invoices, { today, cfg });
  result.skipped = plan.skipped;
  const sentSummary = [];
  let lastError = null;

  for (const item of plan.sends.slice(0, cfg.send.maxPerRun)) {
    const { customer, invoices: group, step } = item;
    const msg = renderReminder({ tone: step.tone, customer, invoices: group, cfg, today });
    const view = { customer: customer.name, to: customer.email, tone: step.tone, invoices: group.map(i => i.invoice_number), total: formatMoney(item.totalCents, cfg.business.currency, cfg.business.locale), subject: msg.subject };

    if (cfg.dryRun) { result.preview.push({ ...view, body: msg.text }); continue; }

    const sent = await sendCustomerEmail({ cfg, customer, to: customer.email, subject: msg.subject, text: msg.text, html: msg.html, kind: 'reminder', invoiceIds: group.map(i => i.id), stepKey: step.key, tone: step.tone });
    if (!sent.ok) { result.failed++; lastError = sent.error; continue; }
    result.sent++;
    sentSummary.push(`${customer.name}: ${view.invoices.join(', ')} (${view.total}) — ${step.tone.replace('_', ' ')} reminder`);

    const stamp = new Date().toISOString();
    for (const inv of group) {
      const patch = { last_reminder_at: stamp, ...(step.index !== null ? { reminder_count: step.index + 1 } : { broken_promise_at: null }) };
      must(await supabase.from('invoices').update(patch).eq('id', inv.id));
      await logEvent({ invoiceId: inv.id, customerId: customer.id, type: 'reminder_sent', details: { step: step.key, tone: step.tone } });
    }
    must(await supabase.from('customers').update({ last_contacted_at: stamp }).eq('id', customer.id));

    // optional SMS on the later steps (only with consent, a phone number, and SMS switched on)
    if (step.sms && cfg.sms.enabled && customer.phone && customer.sms_consent) {
      await sendCustomerSms({ cfg, customer, body: renderSms({ tone: step.tone, customer, invoices: group, cfg, today }), invoiceIds: group.map(i => i.id), stepKey: step.key, tone: step.tone });
    }
  }

  // 3) tell the owner what happened, so a mistake (e.g. a paid invoice still being chased) is caught the same day
  if (!cfg.dryRun && result.sent > 0 && cfg.notifyOnSend) {
    await alertOwner({ level: 'info', key: `sent:${nowISO}`, headline: `Sent ${result.sent} payment reminder${result.sent === 1 ? '' : 's'}`, lines: sentSummary })
      .catch(e => console.error(e.message));
  }
  if (!cfg.dryRun && result.failed > 0) {
    await alertOwner({ level: 'action', key: 'send_failed', dedupeHours: 6, headline: `${result.failed} reminder${result.failed === 1 ? '' : 's'} failed to send`, lines: [`Last error: ${lastError}`, 'Nothing was lost — each one is retried on the next run. If the error mentions credentials, regenerate the Gmail App Password.'] })
      .catch(e => console.error(e.message));
  }
  return result;
}

module.exports = { runChase };