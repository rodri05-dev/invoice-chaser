// Every customer-facing word is written HERE, in fixed templates. The AI never writes text that
// goes to a customer; it only reads replies. That keeps every email auditable and on-brand.
const { formatMoney, balanceCents } = require('./money');
const { formatDate, daysBetween } = require('./dates');
const { esc } = require('./util');

const greeting = c => (c.contact_name && c.contact_name.trim() ? `Hi ${c.contact_name.trim().split(/\s+/)[0]},` : 'Hello,');

function rowsOf(invoices, cfg, today) {
  return invoices.map(i => ({
    number: i.invoice_number,
    due: formatDate(i.due_date, cfg.business.locale),
    overdue: Math.max(0, daysBetween(i.due_date, today)),
    amount: formatMoney(balanceCents(i), i.currency || cfg.business.currency, cfg.business.locale),
    url: i.invoice_url || ''
  }));
}

// n = how many invoices the email covers; ctx.promisedDate is only used by broken_promise.
const COPY = {
  friendly: {
    subject: ({ r, n }) => (n === 1 ? `Invoice ${r[0].number} — a quick reminder` : `A quick reminder about ${n} open invoices`),
    intro: ({ n }) => `This is a friendly reminder that ${n === 1 ? 'the invoice below was' : 'the invoices below were'} due and ${n === 1 ? 'is' : 'are'} still open on our side. If you've already sent payment, thank you — please ignore this note.`,
    close: () => `If anything is holding payment up — a missing PO number, a question about the invoice, or someone else who handles payments — just reply to this email and we'll sort it out.`
  },
  follow_up: {
    subject: ({ r, n }) => (n === 1 ? `Following up: invoice ${r[0].number} is ${r[0].overdue} days past due` : `Following up: ${n} invoices are past due`),
    intro: ({ n }) => `Following up on my earlier note — ${n === 1 ? 'the invoice below is' : 'the invoices below are'} now past due.`,
    close: () => `Could you let me know when we can expect payment? A one-line reply with the expected date is all I need. If there's a problem with the invoice, tell me and I'll sort it out with you.`
  },
  firm: {
    subject: ({ r, n }) => (n === 1 ? `Past due: invoice ${r[0].number} — ${r[0].amount}` : `Past due: ${n} invoices need attention`),
    intro: ({ n }) => `${n === 1 ? 'The invoice below is' : 'The invoices below are'} now well past due and we haven't had a reply yet.`,
    close: () => `Please arrange payment this week, or reply and tell us if something is wrong with the invoice so we can resolve it. If payment has already been sent, please share the date and a reference so we can match it.`
  },
  final: {
    subject: ({ r, n }) => (n === 1 ? `Final reminder: invoice ${r[0].number} — ${r[0].amount} past due` : `Final reminder: ${n} past-due invoices`),
    intro: ({ n }) => `This is our final automated reminder about ${n === 1 ? 'the invoice below' : 'the invoices below'}. ${n === 1 ? 'It remains' : 'They remain'} unpaid well after the due date.`,
    close: () => `Please reply today with a payment date, or get in touch so we can talk it through. If we don't hear from you, one of our team will follow up with you directly.`
  },
  broken_promise: {
    subject: ({ r, n }) => (n === 1 ? `Invoice ${r[0].number}: payment was expected by ${r[0].promisedDate || 'the date you gave us'}` : `${n} invoices: payment was expected`),
    intro: ({ n, promisedDate }) => `Thanks for letting us know when payment would arrive${promisedDate ? ` (${promisedDate})` : ''}. We haven't seen ${n === 1 ? 'it' : 'them'} come through yet.`,
    close: () => `Could you check on the status and let us know the new expected date — or a payment reference if it's already on its way?`
  }
};

function tableText(r) {
  return r.map(x => `  - ${x.number} — ${x.amount} — due ${x.due}${x.overdue ? ` (${x.overdue} days past due)` : ''}${x.url ? `\n    ${x.url}` : ''}`).join('\n');
}

function tableHtml(r) {
  const th = 'text-align:left;padding:6px 10px;border-bottom:1px solid #d5ddd9;font-weight:600;font-size:13px;color:#5b6b64';
  const td = 'padding:8px 10px;border-bottom:1px solid #e7ece9;font-size:14px';
  return `<table style="border-collapse:collapse;width:100%;margin:14px 0"><tr><th style="${th}">Invoice</th><th style="${th}">Due</th><th style="${th};text-align:right">Days late</th><th style="${th};text-align:right">Amount</th></tr>` +
    r.map(x => `<tr><td style="${td}">${x.url ? `<a href="${esc(x.url)}" style="color:#1f5f8b">${esc(x.number)}</a>` : esc(x.number)}</td><td style="${td}">${esc(x.due)}</td><td style="${td};text-align:right">${x.overdue || '—'}</td><td style="${td};text-align:right;font-variant-numeric:tabular-nums">${esc(x.amount)}</td></tr>`).join('') +
    '</table>';
}

const wrapHtml = inner => `<div style="font:15px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c2421;max-width:580px">${inner}</div>`;
const p = t => `<p style="margin:0 0 12px;white-space:pre-line">${esc(t)}</p>`;

function signOff(cfg) { return `Thank you,\n${cfg.business.signOff}\n${cfg.business.name}`; }

function renderReminder({ tone, customer, invoices, cfg, today }) {
  const r = rowsOf(invoices, cfg, today);
  const n = r.length;
  const promised = invoices.find(i => i.promised_date);
  const ctx = { r: r.map(x => ({ ...x, promisedDate: promised ? formatDate(promised.promised_date, cfg.business.locale) : '' })), n, promisedDate: promised ? formatDate(promised.promised_date, cfg.business.locale) : '' };
  const c = COPY[tone] || COPY.follow_up;
  const pay = cfg.business.paymentInstructions ? `How to pay:\n${cfg.business.paymentInstructions}` : '';
  const fee = (tone === 'firm' || tone === 'final') && cfg.business.lateFeeNote ? cfg.business.lateFeeNote : '';

  const subject = c.subject(ctx);
  const text = [
    greeting(customer), '', c.intro(ctx), '', tableText(r),
    ...(pay ? ['', pay] : []), ...(fee ? ['', fee] : []),
    '', c.close(ctx), '', signOff(cfg)
  ].join('\n');
  const html = wrapHtml(p(greeting(customer)) + p(c.intro(ctx)) + tableHtml(r) + (pay ? p(pay) : '') + (fee ? p(fee) : '') + p(c.close(ctx)) + p(signOff(cfg)));
  return { subject, text, html };
}

// Fixed acknowledgements sent when a customer replies. kind: promise_ack | paid_ack | invoice_copy
function renderAck({ kind, customer, invoices, date, cfg, today }) {
  const r = rowsOf(invoices, cfg, today);
  const what = r.length === 1 ? `invoice ${r[0].number}` : `invoices ${r.map(x => x.number).join(', ')}`;
  const total = formatMoney(invoices.reduce((s, i) => s + balanceCents(i), 0), cfg.business.currency, cfg.business.locale);
  let paras;
  if (kind === 'promise_ack') paras = [`Thanks for letting us know — we've noted that payment for ${what} (${total}) is expected by ${formatDate(date, cfg.business.locale)}.`, `If anything changes, just reply to this email.`];
  else if (kind === 'paid_ack') paras = [`Thanks — we'll look for the payment on our side and let you know if we have any questions about ${what}.`, `If you have a payment reference or remittance advice handy, feel free to send it; it helps us match the payment faster.`];
  else paras = [`Here are the details for ${what}:`, tableText(r), cfg.business.paymentInstructions ? `How to pay:\n${cfg.business.paymentInstructions}` : '', `If you need anything else (for example remittance details), just reply and we'll send it.`].filter(Boolean);
  const text = [greeting(customer), '', ...paras.flatMap(x => [x, '']), signOff(cfg)].join('\n');
  const html = wrapHtml(p(greeting(customer)) + paras.map(x => (x === tableText(r) ? tableHtml(r) : p(x))).join('') + p(signOff(cfg)));
  return { text, html };
}

// Short text for the optional SMS step.
function renderSms({ tone, customer, invoices, cfg, today }) {
  const r = rowsOf(invoices, cfg, today);
  const name = customer.contact_name ? customer.contact_name.trim().split(/\s+/)[0] : '';
  const total = formatMoney(invoices.reduce((s, i) => s + balanceCents(i), 0), cfg.business.currency, cfg.business.locale);
  const what = r.length === 1 ? `invoice ${r[0].number} (${r[0].amount}) is ${r[0].overdue} days past due` : `${r.length} invoices (${total}) are past due`;
  const lead = tone === 'broken_promise' ? 'We haven\'t seen the payment you mentioned yet' : tone === 'final' ? 'Final reminder' : 'Reminder';
  return `${name ? `Hi ${name}, ` : ''}${lead} from ${cfg.business.name}: ${what}. Details are in your email. Reply STOP to opt out.`;
}

module.exports = { renderReminder, renderAck, renderSms, rowsOf, wrapHtml, esc };