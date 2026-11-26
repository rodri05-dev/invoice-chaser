// Alerts to YOU (the owner), each with signed one-click buttons. Customers never see any of this.
const { getConfig } = require('./config');
const { supabase, logEvent } = require('./db');
const { sign } = require('./tokens');
const { esc } = require('./util');
const { sendOwnerEmail } = require('./outbound');

const PREFIX = { urgent: '[URGENT] ', action: '', info: '[FYI] ' };

// level: urgent | action | info.   actions: [{ label, action, invoiceId?, customerId?, params? }]
// dedupeHours: skip if an alert with the same key was already sent recently (stops alert storms).
async function alertOwner({ level = 'action', key, headline, lines = [], actions = [], invoice = null, customer = null, dedupeHours = 0 }) {
  const cfg = getConfig();
  if (dedupeHours > 0) {
    const since = new Date(Date.now() - dedupeHours * 3600 * 1000).toISOString();
    const { data } = await supabase.from('events').select('id').eq('type', 'owner_alert').eq('details->>key', key).gte('created_at', since).limit(1);
    if (data && data.length) return { skipped: 'deduped' };
  }

  const links = [];
  if (cfg.appDomain) {
    for (const a of actions) {
      if (a.action === 'open') continue;
      const url = `https://${cfg.appDomain}/api/act?t=${sign({ a: a.action, i: a.invoiceId || (invoice && invoice.id) || null, c: a.customerId || (customer && customer.id) || null, p: a.params || {} })}`;
      links.push({ label: a.label, url });
    }
    links.push({ label: 'Open dashboard', url: `https://${cfg.appDomain}/dashboard.html` });
  }

  const subject = `${PREFIX[level] || ''}${headline}`.slice(0, 180);
  const text = [headline, '', ...lines, '', ...links.map(l => `${l.label}: ${l.url}`)].join('\n');
  const html = `<div style="font:15px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c2421;max-width:600px">` +
    `<p style="font-size:17px;font-weight:600;margin:0 0 12px">${esc(headline)}</p>` +
    lines.map(l => (l === '' ? '<div style="height:8px"></div>' : `<p style="margin:0 0 6px;white-space:pre-line">${esc(l)}</p>`)).join('') +
    `<p style="margin:18px 0 0">${links.map(l => `<a href="${esc(l.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:9px 14px;background:#1c2421;color:#fff;border-radius:3px;text-decoration:none;font-size:14px">${esc(l.label)}</a>`).join('')}</p></div>`;

  await sendOwnerEmail({ subject, text, html });
  await logEvent({ invoiceId: invoice && invoice.id, customerId: customer && customer.id, type: 'owner_alert', details: { key, level, headline } });
  return { sent: true };
}

module.exports = { alertOwner };