const { toCents } = require('./money');

function detectDelimiter(headerLine) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of headerLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && counts[ch] !== undefined) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// Minimal RFC-4180 parser: quoted fields, "" escapes, CRLF, and comma / semicolon / tab delimiters.
function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const delim = detectDelimiter(src.split(/\r?\n/)[0] || '');
  const rows = [];
  let row = [], cur = '', quoted = false;
  const endRow = () => { row.push(cur); cur = ''; if (row.some(c => c.trim() !== '')) rows.push(row); row = []; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; endRow(); }
    else cur += ch;
  }
  if (cur !== '' || row.length) endRow();
  return rows;
}

// Header names people really use -> our field names.
const ALIASES = {
  invoice_number: ['invoice', 'invoicenumber', 'invoiceno', 'invoicenum', 'invno', 'inv', 'number', 'num', 'docnumber', 'reference', 'ref'],
  customer_name: ['customer', 'customername', 'client', 'clientname', 'company', 'companyname', 'billto', 'account', 'name'],
  customer_email: ['email', 'customeremail', 'clientemail', 'billingemail', 'contactemail', 'emailaddress'],
  customer_phone: ['phone', 'customerphone', 'telephone', 'mobile', 'tel'],
  contact_name: ['contact', 'contactname', 'attn', 'attention'],
  amount: ['amount', 'total', 'invoiceamount', 'invoicetotal', 'grandtotal'],
  balance: ['balance', 'balancedue', 'amountdue', 'outstanding', 'open', 'remaining'],
  amount_paid: ['paid', 'amountpaid', 'paidtodate', 'payments'],
  currency: ['currency', 'curr'],
  issue_date: ['date', 'invoicedate', 'issuedate', 'issued', 'created'],
  due_date: ['due', 'duedate', 'datedue', 'paymentdue'],
  invoice_url: ['url', 'link', 'paymentlink', 'invoiceurl', 'paylink'],
  po_number: ['po', 'ponumber', 'purchaseorder'],
  description: ['description', 'memo', 'notes', 'details'],
  status: ['status', 'state']
};
const LOOKUP = {};
for (const [field, names] of Object.entries(ALIASES)) names.forEach(n => { LOOKUP[n] = LOOKUP[n] || field; });
const normHeader = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// text -> { rows: [invoice-shaped objects], errors: [{ line, error }], unmapped: [header names we ignored] }
function csvToInvoices(text) {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], errors: [{ line: 1, error: 'The file needs a header row and at least one invoice row.' }], unmapped: [] };
  const headers = table[0];
  const fieldAt = headers.map(h => LOOKUP[normHeader(h)] || null);
  const used = new Set();
  const cols = fieldAt.map(f => (f && !used.has(f) ? (used.add(f), f) : null));
  const unmapped = headers.filter((h, i) => !cols[i]);
  const rows = [], errors = [];

  table.slice(1).forEach((cells, idx) => {
    const o = {};
    cols.forEach((f, i) => { if (f) o[f] = String(cells[i] || '').trim(); });
    const rec = { ...o };
    delete rec.amount; delete rec.balance; delete rec.amount_paid;
    const amount = toCents(o.amount), balance = toCents(o.balance), paid = toCents(o.amount_paid);
    // Only send a "paid so far" figure when the sheet actually has one, so re-importing a
    // sheet without that column can't wipe out partial payments already recorded.
    if (amount !== null) {
      rec.amount_cents = amount;
      if (balance !== null) rec.amount_paid_cents = Math.max(0, amount - balance);
      else if (paid !== null) rec.amount_paid_cents = paid;
    } else if (balance !== null) { rec.amount_cents = balance; rec.amount_paid_cents = 0; }
    if (!rec.invoice_number && !rec.customer_name && !rec.customer_email) return;   // blank line
    rows.push({ line: idx + 2, ...rec });
  });
  return { rows, errors, unmapped };
}

module.exports = { parseCsv, csvToInvoices };