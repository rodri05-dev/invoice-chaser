// The target of the buttons in alert emails. GET only SHOWS what the button would do.
// Only a deliberate POST from this page changes anything, because mail scanners
// "click" every link in an email, and a GET that changed data would be triggered by them.
const { verify } = require('../lib/tokens');
const { performAction } = require('../lib/actions');
const { supabase, must } = require('../lib/db');
const { esc } = require('../lib/util');
const { formatMoney, balanceCents } = require('../lib/money');
const { getConfig } = require('../lib/config');

const DESCRIBE = {
  mark_paid: () => 'Mark this invoice as paid',
  resume: () => 'Resume automatic reminders',
  snooze: p => `Pause reminders for ${p.days || 7} days`,
  stop: () => 'Stop chasing this invoice',
  void: () => 'Void this invoice — it will no longer be chased or counted',
  set_promise: p => `Record that payment is expected by ${p.date}`,
  set_contact: p => `Send future reminders to ${p.email}`,
  allow_contact: () => 'Allow automatic contact with this customer again'
};

const page = body => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice Chaser</title>
<style>body{margin:0;background:#f4f6f5;color:#1c2421;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}main{max-width:520px;margin:12vh auto;padding:0 20px}
h1{font-size:21px;margin:0 0 6px}p{margin:0 0 14px}.meta{color:#5b6b64;font-size:14px}button{width:100%;padding:13px;border:0;border-radius:3px;background:#1c2421;color:#fff;font-size:16px;cursor:pointer}
dl{margin:16px 0;font-size:14px}dt{color:#5b6b64;margin-top:10px}dd{margin:2px 0 0}</style><main>${body}</main></html>`;

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const token = (req.method === 'POST' ? req.body && req.body.t : req.query.t) || '';
  const p = verify(token);
  if (!p || !DESCRIBE[p.a]) return res.status(400).send(page(`<h1>This link has expired or isn't valid.</h1><p class="meta">Open the dashboard to make the change instead.</p>`));

  try {
    const cfg = getConfig();
    const inv = p.i ? must(await supabase.from('invoices').select('*, customers(name)').eq('id', p.i).maybeSingle()) : null;
    const customerId = p.c || (inv && inv.customer_id) || null;
    const params = p.p || {};

    if (req.method !== 'POST') {
      return res.status(200).send(page(`<h1>${esc(DESCRIBE[p.a](params))}</h1>
<p class="meta">Nothing has changed yet.</p>
<dl>${inv ? `<dt>Invoice</dt><dd>${esc(inv.invoice_number)} — ${esc(formatMoney(balanceCents(inv), inv.currency || cfg.business.currency, cfg.business.locale))}, due ${esc(inv.due_date)}</dd><dt>Customer</dt><dd>${esc(inv.customers && inv.customers.name)}</dd><dt>Status now</dt><dd>${esc(inv.status)}${inv.status_note ? ` — ${esc(inv.status_note)}` : ''}</dd>` : ''}</dl>
<form method="POST" action="/api/act"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Confirm</button></form>`));
    }

    await performAction({ action: p.a, invoiceId: p.i, customerId, params, actor: 'owner (email link)' });
    return res.status(200).send(page(`<h1>Done.</h1><p>${esc(DESCRIBE[p.a](params))} — saved.</p>`));
  } catch (e) {
    console.error('act failed:', e);
    return res.status(400).send(page(`<h1>That didn't work.</h1><p class="meta">${esc(e.message)}</p>`));
  }
};