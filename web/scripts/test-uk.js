// node scripts/test-uk.js  — checks the UK rules: GBP, en-GB dates, London hours, +44 phones,
// UK insolvency / court words, UK wording. No database, email or AI involved.
process.env.GMAIL_ADDRESS = 'chaser@example.com';

const assert = require('assert');
const { getConfig } = require('../lib/config');
const D = require('../lib/dates');
const { formatMoney } = require('../lib/money');
const { normPhone } = require('../lib/util');
const C = require('../lib/classify');
const T = require('../lib/templates');

let passed = 0; const failures = [];
const test = (name, fn) => { try { fn(); passed++; } catch (e) { failures.push(`✗ ${name}\n    ${e.message.split('\n')[0]}`); } };
const eq = assert.deepStrictEqual;

test('uk: the defaults are UK ones', () => {
  const c = getConfig({});
  eq([c.business.timezone, c.business.locale, c.business.currency], ['Europe/London', 'en-GB', 'GBP']);
  eq([c.send.skipBankHolidays, c.send.region], [true, 'england-and-wales']);
});
test('uk: bank holiday settings can be changed', () => {
  const c = getConfig({ SKIP_BANK_HOLIDAYS: 'false', UK_REGION: ' Scotland ' });
  eq([c.send.skipBankHolidays, c.send.region], [false, 'scotland']);
});
test('uk: pounds, and dates read day first', () => {
  eq(formatMoney(125000, 'GBP', 'en-GB'), '£1,250.00');
  eq(D.parseDateLoose('03/04/2026', 'en-GB'), '2026-04-03');
  eq(D.parseDateLoose('03/04/2026', 'en-US'), '2026-03-04');
  eq(D.parseDateLoose('25/12/2026', 'en-GB'), '2026-12-25');
  assert(/^15 Sep/.test(D.formatDate('2026-09-15', 'en-GB')));
});
test('uk: the sending window follows London time (summer and winter)', () => {
  const c = getConfig({});
  eq(D.inSendWindow(new Date('2026-09-30T07:30:00Z'), c), false);   // Wed 08:30 BST
  eq(D.inSendWindow(new Date('2026-09-30T08:30:00Z'), c), true);    // Wed 09:30 BST
  eq(D.inSendWindow(new Date('2026-09-30T15:30:00Z'), c), true);    // Wed 16:30 BST
  eq(D.inSendWindow(new Date('2026-09-30T16:30:00Z'), c), false);   // Wed 17:30 BST
  eq(D.inSendWindow(new Date('2026-12-02T08:30:00Z'), c), false);   // Wed 08:30 GMT
  eq(D.inSendWindow(new Date('2026-12-02T09:30:00Z'), c), true);    // Wed 09:30 GMT
  eq(D.inSendWindow(new Date('2026-10-03T10:00:00Z'), c), false);   // Saturday
});
test('uk: phone numbers become +44', () => {
  process.env.PHONE_COUNTRY_CODE = '44';
  try {
    eq(normPhone('07123 456789'), '+447123456789');
    eq(normPhone('+44 7123 456789'), '+447123456789');
    eq(normPhone('0044 7123 456789'), '+447123456789');
    eq(normPhone('020 7946 0958'), '+442079460958');
  } finally { delete process.env.PHONE_COUNTRY_CODE; }
});
test('uk: safety net catches UK insolvency, court and data-rights words', () => {
  eq(C.safetyScan('We have appointed liquidators'), 'bankruptcy');
  eq(C.safetyScan('The company has gone into liquidation'), 'bankruptcy');
  eq(C.safetyScan('Administrators have been appointed'), 'bankruptcy');
  eq(C.safetyScan('We entered administration last week'), 'bankruptcy');
  eq(C.safetyScan('A winding-up petition was filed'), 'bankruptcy');
  eq(C.safetyScan('We agreed a CVA with creditors'), 'bankruptcy');
  eq(C.safetyScan('Our solicitor will be in touch'), 'legal');
  eq(C.safetyScan('You may get a CCJ for this'), 'legal');
  eq(C.safetyScan('This could end up in the county court'), 'legal');
  eq(C.safetyScan('We received a statutory demand'), 'legal');
  eq(C.safetyScan('Please treat this as a letter before action'), 'legal');
  eq(C.safetyScan('I will take this to court'), 'legal');
  eq(C.safetyScan('Please treat this as a subject access request'), 'stop');
  eq(C.safetyScan('Please delete my data'), 'stop');
});
test('uk: the safety net does not fire on ordinary UK sentences', () => {
  eq(C.safetyScan('I am the office administrator'), null);
  eq(C.safetyScan('The contract has a liquidated damages clause'), null);
  eq(C.safetyScan('Our address is Court Road, Leeds'), null);
  eq(C.safetyScan('We are winding up the works next week'), null);
  eq(C.safetyScan('Thanks, we will pay by BACS on Friday'), null);
  eq(C.safetyScan('Please stop emailing me'), 'stop');
});
test('uk: reminders read as UK English', () => {
  const c = getConfig({ BUSINESS_NAME: 'Acme Ltd', PAYMENT_INSTRUCTIONS: 'Sort code 00-00-00, account 00000000' });
  const customer = { id: 'c1', name: 'Beta Ltd', contact_name: 'Sam Jones' };
  const inv = { id: 'i1', invoice_number: 'INV-7', amount_cents: 100000, amount_paid_cents: 0, currency: 'GBP', due_date: '2026-09-15' };
  const args = { customer, invoices: [inv], cfg: c, today: '2026-09-30' };
  const fu = T.renderReminder({ tone: 'follow_up', ...args });
  assert(fu.subject.includes('15 days overdue') && fu.text.includes('£1,000.00') && /15 Sep/.test(fu.text) && fu.text.includes('Sort code 00-00-00'));
  assert(!/past due/i.test(fu.text) && !/past due/i.test(fu.subject));
  assert(T.renderReminder({ tone: 'firm', ...args }).subject.startsWith('Overdue:'));
  assert(T.renderReminder({ tone: 'final', ...args }).subject.startsWith('Final reminder'));
  const sms = T.renderSms({ tone: 'firm', ...args });
  assert(sms.includes('overdue') && sms.includes('Reply STOP'));
});

console.log(failures.length ? failures.join('\n') : '');
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
