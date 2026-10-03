require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const base = (process.argv[2] || `https://${process.env.APP_DOMAIN}`).replace(/\/$/, '');
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const invoices = [
  { invoice_number: 'INV-1001', customer_name: 'Acme Corp',   customer_email: 'ap@acme-test.example',      contact_name: 'Jo Smith', amount: 1250, due_date: day(-3),  invoice_url: 'https://example.com/pay/1001' },
  { invoice_number: 'INV-1002', customer_name: 'Acme Corp',   customer_email: 'ap@acme-test.example',      amount: 500,  due_date: day(-3) },
  { invoice_number: 'INV-2001', customer_name: 'Beta LLC',    customer_email: 'billing@beta-test.example', contact_name: 'Sam', amount: 9000, due_date: day(-40) },
  { invoice_number: 'INV-3001', customer_name: 'Gamma Ltd',   customer_email: 'x@gamma-test.example',      amount: 100,  due_date: day(10) },
  { invoice_number: 'INV-4001', customer_name: 'Delta Group', customer_email: 'd@delta-test.example',      amount: 300,  due_date: day(-10) }
];

(async () => {
  const res = await fetch(`${base}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.INGEST_API_KEY}` },
    body: JSON.stringify({ invoices })
  });
  console.log(res.status, JSON.stringify(await res.json(), null, 2));
})().catch(e => { console.error(e.message); process.exit(1); });