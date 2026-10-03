// Which customer (and which invoices) is this reply about? Tried in order of trustworthiness:
//   1. the secret token in the Reply-To plus-address   2. the sender is a known billing address
//   3. same company domain                              4. an invoice number written in the message
const { supabase, must, fetchAll } = require('./db');
const { escapeRegExp } = require('./util');

const ACTIVE = ['open', 'promised', 'payment_claimed', 'disputed', 'on_hold', 'escalated'];
const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|aol|proton|protonmail|pm|gmx|mail|zoho)\./i;

const domainOf = e => String(e || '').split('@')[1] || '';
const sameOrg = (a, b) => { const x = domainOf(a).toLowerCase(), y = domainOf(b).toLowerCase(); return !!x && x === y && !FREE_MAIL.test(x); };
const knownSender = (from, c) => [c.email, ...(c.extra_emails || [])].filter(Boolean).some(e => e === from || sameOrg(e, from));
const mentions = (text, num) => String(num).length >= 3 && new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(num)}([^A-Za-z0-9]|$)`, 'i').test(text);

// you+a1b2c3d4e5@gmail.com -> "a1b2c3d4e5", but only for OUR mailbox
function tokenFrom(addresses) {
  const [local, domain] = String(process.env.GMAIL_ADDRESS || '').toLowerCase().split('@');
  for (const a of addresses) {
    const m = String(a).match(/^([^+@]+)\+([a-z0-9]{6,16})@(.+)$/i);
    if (m && m[1].toLowerCase() === local && m[3].toLowerCase() === domain) return m[2].toLowerCase();
  }
  return null;
}

async function customersByInvoiceNumber(text, onlyIds = null) {
  const inv = await fetchAll(() => supabase.from('invoices').select('invoice_number, customer_id').in('status', ACTIVE).order('id'));
  const ids = new Set(inv.filter(i => mentions(text, i.invoice_number) && (!onlyIds || onlyIds.includes(i.customer_id))).map(i => i.customer_id));
  return [...ids];
}

async function matchInbound({ channel = 'email', fromEmail = '', fromPhone = '', toAddresses = [], subject = '', body = '' }) {
  if (channel === 'sms') {
    const c = fromPhone ? must(await supabase.from('customers').select('*').eq('phone', fromPhone).limit(1))[0] : null;
    return c ? { customer: c, method: 'phone', senderKnown: true } : { customer: null };
  }
  const from = String(fromEmail).toLowerCase();

  const token = tokenFrom(toAddresses);
  if (token) {
    const c = must(await supabase.from('customers').select('*').eq('reply_token', token).limit(1))[0];
    if (c) return { customer: c, method: 'token', senderKnown: true };
  }

  if (from) {
    const direct = must(await supabase.from('customers').select('*').eq('email', from));
    const extra = must(await supabase.from('customers').select('*').contains('extra_emails', [from]));
    const found = [...direct, ...extra.filter(e => !direct.some(d => d.id === e.id))];
    if (found.length === 1) return { customer: found[0], method: 'sender', senderKnown: true };
    if (found.length > 1) {                                   // e.g. one bookkeeper paying for several customers: the invoice number decides
      const hits = await customersByInvoiceNumber(`${subject}\n${body}`, found.map(c => c.id));
      return hits.length === 1 ? { customer: found.find(c => c.id === hits[0]), method: 'sender', senderKnown: true } : { customer: null };
    }
    const dom = domainOf(from).toLowerCase();
    if (dom && !FREE_MAIL.test(dom)) {
      const sameDomain = must(await supabase.from('customers').select('*').ilike('email', `%@${dom}`));
      if (sameDomain.length === 1) return { customer: sameDomain[0], method: 'domain', senderKnown: true };
    }
  }

  const ids = await customersByInvoiceNumber(`${subject}\n${body}`);
  if (ids.length === 1) {
    const c = must(await supabase.from('customers').select('*').eq('id', ids[0]).single());
    return { customer: c, method: 'invoice_number', senderKnown: from ? knownSender(from, c) : false };
  }
  return { customer: null };
}

// The invoices this reply applies to: ones it names, else the ones in our latest reminder, else everything open.
async function loadCandidates(customer, { text = '', subject = '' } = {}) {
  const all = must(await supabase.from('invoices').select('*').eq('customer_id', customer.id).in('status', ACTIVE).order('due_date'));
  const named = all.filter(i => mentions(`${subject}\n${text}`, i.invoice_number));
  if (named.length) return { targets: named, allActive: all };
  const since = new Date(Date.now() - 45 * 86400000).toISOString();
  const last = must(await supabase.from('outbound_messages').select('invoice_ids')
    .eq('customer_id', customer.id).eq('kind', 'reminder').eq('status', 'sent').gte('created_at', since).order('created_at', { ascending: false }).limit(1));
  const ids = (last[0] && last[0].invoice_ids) || [];
  const linked = all.filter(i => ids.includes(i.id));
  return { targets: linked.length ? linked : all, allActive: all };
}

module.exports = { matchInbound, loadCandidates, tokenFrom, sameOrg, knownSender };