// The Monday-morning cash report: one email that answers "where is my money?".
const { supabase, must, fetchAll } = require('./db');
const { getConfig } = require('./config');
const { todayISO, mondayOf, formatDate } = require('./dates');
const { formatMoney } = require('./money');
const { OPEN, BUCKETS, computeMetrics, attentionList } = require('./metrics');
const { sendOwnerEmail } = require('./outbound');
const { esc } = require('./util');

async function loadData(cfg, now = new Date()) {
  const today = todayISO(cfg.business.timezone, now);
  const open = await fetchAll(() => supabase.from('invoices').select('*, customers(name, email, do_not_contact, email_bounced)').in('status', OPEN).order('due_date').order('id'));
  const paid = await fetchAll(() => supabase.from('invoices').select('*, customers(name)').eq('status', 'paid')
    .gte('paid_at', new Date(now.getTime() - 100 * 86400000).toISOString()).order('paid_at').order('id'));
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const events = await fetchAll(() => supabase.from('events').select('type').gte('created_at', weekAgo).order('created_at').order('id'));
  const count = t => events.filter(e => e.type === t).length;
  const replies = await supabase.from('inbound_messages').select('id', { count: 'exact', head: true }).eq('kind', 'reply').gte('created_at', weekAgo);
  return {
    today, open, paid,
    stats: { reminders: count('reminder_sent'), replies: replies.count || 0, promises: count('promise_recorded'), broken: count('promise_broken'), paid: count('mark_paid') }
  };
}

const COLORS = ['#5f9b7a', '#c9a23a', '#d98a2b', '#c4572f', '#9e2f2f'];
const REASON = { disputed: 'Disputed', escalated: 'Needs a personal call', payment_claimed: 'Says they paid — verify', on_hold: 'On hold', no_contact: 'Can’t be contacted' };

function buildReport({ today, open, paid, stats, cfg }) {
  const m = computeMetrics({ invoices: [...open, ...paid], today, cfg });
  const attention = attentionList(open, today);
  const $ = c => formatMoney(c, m.currency, cfg.business.locale);
  const dash = cfg.appDomain ? `https://${cfg.appDomain}/dashboard.html` : '';
  const total = m.outstanding.cents || 1;
  const subject = `Cash report: ${$(m.outstanding.cents)} outstanding, ${$(m.overdue.cents)} overdue, ${$(m.collected.week.cents)} collected this week`;

  // ---- plain text ----
  const t = [`Cash report — ${cfg.business.name} — ${formatDate(today, cfg.business.locale)}`, '',
    `Outstanding: ${$(m.outstanding.cents)} across ${m.outstanding.count} invoices`,
    `Overdue: ${$(m.overdue.cents)} across ${m.overdue.count} invoices (${$(m.newlyOverdue.cents)} became overdue in the last 7 days)`,
    `Collected: ${$(m.collected.week.cents)} in the last 7 days (${m.collected.week.count} invoices), ${$(m.collected.month.cents)} in the last 30 days`,
    `Average days to pay: ${m.avgDaysToPay === null ? 'n/a' : m.avgDaysToPay} (paid ${m.avgDaysLate === null ? 'n/a' : m.avgDaysLate} days after the due date on average, last 90 days)`, '', 'Aging'];
  for (const [k, label] of BUCKETS) t.push(`  ${label}: ${$(m.aging[k].cents)} (${m.aging[k].count})`);
  t.push('', 'Expected in the next 7 days');
  m.promisedNext7.forEach(x => t.push(`  Promised ${formatDate(x.date, cfg.business.locale)}: ${x.customer}, ${x.invoice}, ${$(x.cents)}`));
  m.dueNext7.forEach(x => t.push(`  Due ${formatDate(x.date, cfg.business.locale)}: ${x.customer}, ${x.invoice}, ${$(x.cents)}`));
  if (!m.promisedNext7.length && !m.dueNext7.length) t.push('  Nothing scheduled.');
  t.push('', 'Needs you');
  attention.slice(0, 15).forEach(a => t.push(`  ${REASON[a.reason]}: ${a.customer}, ${a.invoice}, ${$(a.cents)}${a.note ? ` — ${a.note}` : ''}`));
  if (!attention.length) t.push('  Nothing — the automation has it covered.');
  t.push('', 'Biggest overdue balances');
  m.topOverdue.forEach(c => t.push(`  ${c.customer}: ${$(c.cents)} (${c.count} invoice${c.count === 1 ? '' : 's'}, oldest ${c.oldest} days late)`));
  t.push('', `Chaser this week: ${stats.reminders} reminders sent, ${stats.replies} replies read, ${stats.promises} promises recorded, ${stats.broken} promises broken, ${stats.paid} invoices marked paid.`);
  if (m.otherCurrencyInvoices) t.push(`(${m.otherCurrencyInvoices} open invoices in other currencies are not included in these totals.)`);
  if (dash) t.push('', `Dashboard: ${dash}`);

  // ---- HTML ----
  const h2 = s => `<h2 style="font-size:15px;margin:26px 0 8px;padding-top:14px;border-top:1px solid #dfe5e1">${s}</h2>`;
  const td = 'padding:5px 0;font-size:14px;vertical-align:middle';
  const fig = (label, value, sub) => `<td style="padding:0 18px 0 0;vertical-align:top"><div style="font-size:12px;color:#5b6b64">${label}</div><div style="font-size:22px;font-weight:600;font-variant-numeric:tabular-nums">${value}</div><div style="font-size:12px;color:#5b6b64">${sub}</div></td>`;
  const list = (rows, empty) => (rows.length ? rows.map(r => `<div style="${td}">${r}</div>`).join('') : `<div style="${td};color:#5b6b64">${empty}</div>`);

  const html = `<div style="font:15px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c2421;max-width:620px">
<p style="font-size:13px;color:#5b6b64;margin:0">${esc(cfg.business.name)} · ${esc(formatDate(today, cfg.business.locale))}</p>
<h1 style="font-size:21px;margin:4px 0 16px">Where your money is</h1>
<table style="border-collapse:collapse"><tr>
${fig('Outstanding', esc($(m.outstanding.cents)), `${m.outstanding.count} invoices`)}
${fig('Overdue', esc($(m.overdue.cents)), `${m.overdue.count} invoices`)}
${fig('Collected, 7 days', esc($(m.collected.week.cents)), `${m.collected.week.count} invoices`)}
${fig('Days to pay', m.avgDaysToPay === null ? '—' : m.avgDaysToPay, 'average, last 90 days')}
</tr></table>
${h2('How late it is')}
<table style="border-collapse:collapse;width:100%">${BUCKETS.map(([k, label], i) => {
    const b = m.aging[k]; const pct = Math.max(b.cents ? 2 : 0, Math.round((b.cents / total) * 100));
    return `<tr><td style="${td};width:30%">${esc(label)}</td><td style="${td};width:42%"><div style="height:10px;width:${pct}%;background:${COLORS[i]}"></div></td><td style="${td};text-align:right;font-variant-numeric:tabular-nums">${esc($(b.cents))}</td><td style="${td};text-align:right;color:#5b6b64;width:36px">${b.count}</td></tr>`;
  }).join('')}</table>
${h2('Expected in the next 7 days')}
${list([...m.promisedNext7.map(x => `<strong>Promised ${esc(formatDate(x.date, cfg.business.locale))}</strong> — ${esc(x.customer)}, ${esc(x.invoice)}, ${esc($(x.cents))}`), ...m.dueNext7.map(x => `Due ${esc(formatDate(x.date, cfg.business.locale))} — ${esc(x.customer)}, ${esc(x.invoice)}, ${esc($(x.cents))}`)], 'Nothing scheduled.')}
${h2('Needs you')}
${list(attention.slice(0, 15).map(a => `<strong>${esc(REASON[a.reason])}</strong> — ${esc(a.customer)}, ${esc(a.invoice)}, ${esc($(a.cents))}${a.note ? `<br><span style="color:#5b6b64">${esc(a.note)}</span>` : ''}`), 'Nothing — the automation has it covered.')}
${h2('Biggest overdue balances')}
${list(m.topOverdue.map(c => `${esc(c.customer)} — <strong>${esc($(c.cents))}</strong> (${c.count} invoice${c.count === 1 ? '' : 's'}, oldest ${c.oldest} days late)`), 'Nothing overdue.')}
<p style="font-size:13px;color:#5b6b64;margin:22px 0 0">This week the chaser sent ${stats.reminders} reminders, read ${stats.replies} replies, recorded ${stats.promises} promises (${stats.broken} broken) and saw ${stats.paid} invoices marked paid.${m.otherCurrencyInvoices ? ` ${m.otherCurrencyInvoices} open invoices in other currencies are not included in the totals.` : ''}</p>
${dash ? `<p style="margin:14px 0 0"><a href="${esc(dash)}" style="color:#1f5f8b">Open the dashboard</a></p>` : ''}
</div>`;
  return { subject, text: t.join('\n'), html, metrics: m };
}

async function sendWeeklyReport({ force = false, preview = false } = {}) {
  const cfg = getConfig();
  const data = await loadData(cfg);
  const report = buildReport({ ...data, cfg });
  if (preview) return { preview: true, ...report };
  if (!force) {
    const monday = mondayOf(data.today);
    const done = must(await supabase.from('outbound_messages').select('id').eq('kind', 'report').eq('status', 'sent').gte('created_at', `${monday}T00:00:00Z`).limit(1));
    if (done.length) return { skipped: 'already_sent_this_week' };
  }
  const r = await sendOwnerEmail({ kind: 'report', subject: report.subject, text: report.text, html: report.html });
  return { sent: r.ok, subject: report.subject };
}

module.exports = { loadData, buildReport, sendWeeklyReport };