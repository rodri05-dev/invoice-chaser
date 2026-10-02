// Getting invoices IN: the dashboard form, CSV paste, and the API that Make / Zapier / n8n call.
// Safe to run repeatedly: re-sending the same invoice updates it, never duplicates it.
const { supabase, must, logEvent } = require('./db');
const { getConfig } = require('./config');
const { parseDateLoose } = require('./dates');
const { toCents } = require('./money');
const { normEmail, normPhone } = require('./util');
const { csvToInvoices } = require('./csv');
const { performAction } = require('./actions');

const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const has = (o, ...keys) => keys.some(k => o[k] !== undefined && o[k] !== '');

async function findCustomer({ email, name }) {
  if (email) return must(await supabase.from('customers').select('*').eq('email', email).maybeSingle());
  const rows = must(await supabase.from('customers').select('*').eq('name', name).is('email', null).limit(1));
  return rows[0] || null;
}

async function upsertInvoice(raw, source = 'api') {
  const cfg = getConfig();
  const invoiceNumber = String(raw.invoice_number ?? raw.invoiceNumber ?? '').trim();
  const email = normEmail(raw.customer_email ?? raw.customerEmail ?? raw.email);
  const name = String(raw.customer_name ?? raw.customerName ?? '').trim() || email || '';
  const dueDate = parseDateLoose(raw.due_date ?? raw.dueDate, cfg.business.locale);
  const issueDate = parseDateLoose(raw.issue_date ?? raw.issueDate, cfg.business.locale);
  const amountCents = has(raw, 'amount_cents') ? Number(raw.amount_cents) : toCents(raw.amount);
  const paidProvided = has(raw, 'amount_paid_cents', 'amount_paid');
  const paidCents = has(raw, 'amount_paid_cents') ? Number(raw.amount_paid_cents) : (toCents(raw.amount_paid) || 0);
  const status = String(raw.status || '').toLowerCase().trim();

  const problems = [];
  if (!invoiceNumber) problems.push('invoice_number is missing');
  if (!name) problems.push('customer_name or customer_email is missing');
  if (!dueDate) problems.push('due_date is missing or unreadable');
  if (amountCents === null || !Number.isFinite(amountCents) || amountCents < 0) problems.push('amount is missing or invalid');
  if (problems.length) return { ok: false, error: problems.join('; ') };

  const incomingVoid = /^(void(ed)?|cancel(l)?ed|deleted|draft|written.?off)$/.test(status);
  const incomingPaid = /^(paid|closed|settled|complete(d)?)$/.test(status) || (amountCents > 0 && paidProvided && paidCents >= amountCents);

  let customer = await findCustomer({ email, name });
  const existing = customer
    ? must(await supabase.from('invoices').select('*').eq('customer_id', customer.id).eq('invoice_number', invoiceNumber).maybeSingle())
    : null;

  // Brand-new invoice that is already paid / void / a draft: nothing to chase, nothing to store.
  if (!existing && (incomingPaid || incomingVoid)) return { ok: true, action: 'ignored' };

  if (!customer) {
    customer = must(await supabase.from('customers').insert({
      name, email, phone: normPhone(raw.customer_phone ?? raw.customerPhone ?? raw.phone), contact_name: raw.contact_name || raw.contactName || null
    }).select().single());
  } else {
    const fill = clean({
      phone: !customer.phone ? normPhone(raw.customer_phone ?? raw.customerPhone ?? raw.phone) : undefined,
      contact_name: !customer.contact_name ? (raw.contact_name || raw.contactName) : undefined
    });
    if (Object.keys(fill).length) must(await supabase.from('customers').update(fill).eq('id', customer.id));
  }

  if (!existing) {
    const invoice = must(await supabase.from('invoices').insert(clean({
      customer_id: customer.id, invoice_number: invoiceNumber, source,
      currency: String(raw.currency || cfg.business.currency).toUpperCase(),
      amount_cents: amountCents, amount_paid_cents: paidCents, issue_date: issueDate, due_date: dueDate,
      invoice_url: raw.invoice_url || raw.invoiceUrl, po_number: raw.po_number || raw.poNumber, description: raw.description
    })).select().single());
    await logEvent({ invoiceId: invoice.id, customerId: customer.id, type: 'invoice_created', details: { source } });
    return { ok: true, action: 'created', invoice };
  }

  if (incomingPaid) {
    if (['paid', 'void'].includes(existing.status)) return { ok: true, action: 'ignored', invoice: existing };
    const invoice = await performAction({ action: 'mark_paid', invoiceId: existing.id, params: { paid_at: raw.paid_at }, actor: 'sync' });
    return { ok: true, action: 'paid', invoice };
  }
  if (incomingVoid) {
    if (existing.status === 'void') return { ok: true, action: 'ignored', invoice: existing };
    const invoice = await performAction({ action: 'void', invoiceId: existing.id, actor: 'sync' });
    return { ok: true, action: 'voided', invoice };
  }
  if (['paid', 'void'].includes(existing.status)) return { ok: true, action: 'ignored', invoice: existing };   // never silently re-open a closed invoice

  // Still open: refresh the fields the accounting tool owns. Chasing state (status, reminders, promises) is left alone.
  const patch = clean({
    amount_cents: amountCents, amount_paid_cents: paidProvided ? paidCents : undefined, due_date: dueDate, issue_date: issueDate,
    invoice_url: raw.invoice_url || raw.invoiceUrl, po_number: raw.po_number || raw.poNumber, description: raw.description,
    currency: raw.currency ? String(raw.currency).toUpperCase() : undefined
  });
  const invoice = must(await supabase.from('invoices').update(patch).eq('id', existing.id).select().single());
  if (paidProvided && paidCents > Number(existing.amount_paid_cents)) {
    await logEvent({ invoiceId: existing.id, customerId: customer.id, type: 'partial_payment', details: { paid_cents: paidCents, actor: 'sync' } });
  }
  return { ok: true, action: 'updated', invoice };
}

async function importBatch(rows, source) {
  const out = { created: 0, updated: 0, paid: 0, voided: 0, ignored: 0, errors: [] };
  for (const row of rows) {
    try {
      const r = await upsertInvoice(row, source);
      if (!r.ok) out.errors.push({ line: row.line, invoice: row.invoice_number, error: r.error });
      else out[{ created: 'created', updated: 'updated', paid: 'paid', voided: 'voided', ignored: 'ignored' }[r.action]]++;
    } catch (e) {
      out.errors.push({ line: row.line, invoice: row.invoice_number, error: e.message });
    }
  }
  return out;
}

// { invoice_number, customer_email? }: for payment webhooks that only know the invoice number.
async function markPaidByRef({ invoice_number, customer_email, paid_at }) {
  if (!invoice_number) throw new Error('invoice_number is required');
  const rows = must(await supabase.from('invoices').select('id, status, customers(email)').eq('invoice_number', String(invoice_number).trim()));
  const email = normEmail(customer_email);
  const matches = rows.filter(r => !email || (r.customers && r.customers.email === email));
  if (matches.length === 0) return { created: 0, updated: 0, paid: 0, ignored: 1, errors: [] };
  if (matches.length > 1) throw new Error('More than one customer has that invoice number — include customer_email');
  if (['paid', 'void'].includes(matches[0].status)) return { created: 0, updated: 0, paid: 0, ignored: 1, errors: [] };
  await performAction({ action: 'mark_paid', invoiceId: matches[0].id, params: { paid_at }, actor: 'sync' });
  return { created: 0, updated: 0, paid: 1, ignored: 0, errors: [] };
}

async function ingestPayload(body, source = 'api') {
  if (typeof body.csv === 'string') {
    const { rows, errors, unmapped } = csvToInvoices(body.csv);
    const r = await importBatch(rows, 'csv');
    return { ...r, errors: [...errors, ...r.errors], unmappedColumns: unmapped };
  }
  if (Array.isArray(body.invoices)) return importBatch(body.invoices.slice(0, 500), source);
  if (body.invoice && typeof body.invoice === 'object') return importBatch([body.invoice], source);
  if (body.mark_paid && typeof body.mark_paid === 'object') return markPaidByRef(body.mark_paid);
  throw new Error('Send { invoice }, { invoices: [...] }, { csv: "..." } or { mark_paid: { invoice_number } }');
}

module.exports = { upsertInvoice, importBatch, ingestPayload };