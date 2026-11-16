// node scripts/seed-uk.js  — loads five UK demo invoices (in pounds) into your deployed app through the ingest API.
// Safe to run again: the API updates existing invoices instead of duplicating them.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const base = (process.argv[2] || `https://${process.env.APP_DOMAIN}`).replace(/\/$/, '');
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const invoices = [
  { invoice_number: 'INV-5001', customer_name: 'Aldwych Marketing Ltd',     customer_email: 'accounts@aldwych-test.example',  contact_name: 'Jo Smith',  amount: 1250, currency: 'GBP', due_date: day(-3),  invoice_url: 'https://example.com/pay/5001' },
  { invoice_number: 'INV-5002', customer_name: 'Aldwych Marketing Ltd',     customer_email: 'accounts@aldwych-test.example',  amount: 500,  currency: 'GBP', due_date: day(-3) },
  { invoice_number: 'INV-5003', customer_name: 'Brindley Construction Ltd', customer_email: 'billing@brindley-test.example',  contact_name: 'Sam Patel', amount: 9000, currency: 'GBP', due_date: day(-40) },
  { invoice_number: 'INV-5004', customer_name: 'Canal Street Print Ltd',    customer_email: 'x@canalstreet-test.example',     amount: 1800, currency: 'GBP', due_date: day(10) },
  { invoice_number: 'INV-5005', customer_name: 'Dunmore Logistics Ltd',     customer_email: 'd@dunmore-test.example',         amount: 3200, currency: 'GBP', due_date: day(-10) }
];

(async () => {
  const res = await fetch(`${base}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.INGEST_API_KEY}` },
    body: JSON.stringify({ invoices })
  });
  console.log(res.status, JSON.stringify(await res.json(), null, 2));
})().catch(e => { console.error(e.message); process.exit(1); });
