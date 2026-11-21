// node scripts/test-disputes.js  — checks the dispute reasons, the fixed checklists, the classify changes and
// the policy plan for a dispute. No database, email or AI involved.
process.env.GMAIL_ADDRESS = 'chaser@example.com';

const assert = require('assert');
const { getConfig } = require('../lib/config');
const C = require('../lib/classify');
const { decide } = require('../lib/policy');
const DS = require('../lib/disputes');

let passed = 0; const failures = [];
const test = (name, fn) => { try { fn(); passed++; } catch (e) { failures.push(`✗ ${name}\n    ${e.message.split('\n')[0]}`); } };
const eq = assert.deepStrictEqual;

const TODAY = '2026-11-20';
const NOW_ISO = '2026-11-20T10:00:00.000Z';
const cfg = getConfig({ BUSINESS_NAME: 'Acme Ltd' });
const cust = { id: 'c1', name: 'Brindley Ltd', contact_name: 'Sam', email: 'ap@brindley.example' };
const inv = (o = {}) => ({ id: 'i1', invoice_number: 'INV-9', amount_cents: 125000, amount_paid_cents: 0, currency: 'GBP', status: 'open', due_date: '2026-11-01', customers: cust, ...o });
const cls = o => C.normalize({ confidence: 0.95, sentiment: 'neutral', ...o });
const plan = (o = {}) => decide({ cls: cls({ intent: 'dispute' }), safety: null, customer: cust, targets: [inv()], allActive: [inv()], senderKnown: true, cfg, today: TODAY, nowISO: NOW_ISO, ...o });

test('disputes: every reason has a label and a checklist of plain text lines', () => {
  eq(DS.CATEGORIES.length, 8); assert(DS.CATEGORIES.includes('other'));
  for (const c of DS.CATEGORIES) {
    const i = DS.INFO[c];
    assert(i && i.label && i.label.length > 3, `label for ${c}`);
    assert(Array.isArray(i.collect) && i.collect.length >= 2, `checklist for ${c}`);
    assert(i.collect.every(l => typeof l === 'string' && l.length > 10), `lines for ${c}`);
  }
});
test('disputes: an unknown reason becomes "other"', () => {
  eq(DS.categoryOf('nonsense'), 'other'); eq(DS.categoryOf(undefined), 'other'); eq(DS.categoryOf('missing_po'), 'missing_po');
  eq(DS.labelOf('wrong_amount'), 'Amount disputed'); eq(DS.labelOf('???'), DS.labelOf('other'));
});
test('disputes: the alert lines name the reason and number the checklist', () => {
  const lines = DS.disputeLines('missing_po');
  eq(lines[0], ''); assert(lines[1].includes('PO number missing')); assert(lines[2].includes('What to collect'));
  assert(lines[3].startsWith('  1. ') && lines[lines.length - 1].startsWith(`  ${DS.INFO.missing_po.collect.length}. `));
});
test('classify: the AI reading carries a checked dispute reason', () => {
  eq(C.normalize({ intent: 'dispute', dispute_category: 'wrong_amount' }).dispute_category, 'wrong_amount');
  eq(C.normalize({ intent: 'dispute', dispute_category: 'made_up' }).dispute_category, 'other');
  eq(C.normalize({ intent: 'dispute' }).dispute_category, 'other');
  eq(C.normalize({ intent: 'promise_to_pay', dispute_category: 'wrong_amount' }).dispute_category, null);
  eq(C.normalize({}).dispute_category, null);
});
test('classify: the prompt lists every reason and sends a missing PO to dispute', () => {
  const sys = C.buildMessages({ cfg, today: TODAY, receivedISO: TODAY, customer: cust, invoices: [inv()], replyText: 'x' })[0].content;
  for (const c of DS.CATEGORIES) assert(sys.includes(c), `prompt mentions ${c}`);
  assert(sys.includes('cannot pay until a PO number is added') && !/a PO match/.test(sys));
});
test('policy: a dispute stores the reason, pauses chasing and adds the checklist for the owner', () => {
  const d = plan({ cls: cls({ intent: 'dispute', dispute_category: 'missing_po', dispute_reason: 'Need a PO number' }) });
  eq([d.label, d.disputeCategory, d.alert.level, d.ack], ['disputed', 'missing_po', 'urgent', null]);
  eq(d.patches[0].patch.status, 'disputed'); eq(d.patches[0].patch.paused_until, null);
  assert(d.patches[0].patch.status_note.startsWith('PO number missing') && d.patches[0].patch.status_note.includes('Need a PO number'));
  eq(d.patches[0].event, { type: 'disputed', details: { reason: 'Need a PO number', category: 'missing_po' } });
  assert(d.alert.headline.includes('INV-9') && d.alert.headline.includes('PO number missing'));
  eq(d.alert.actions.map(a => a.action), ['resume', 'mark_paid', 'void']);
  eq(d.alert.extraLines, DS.disputeLines('missing_po'));
});
test('policy: a dispute with no reason is "other", and the note stays short', () => {
  const d = plan({ cls: cls({ intent: 'dispute' }) });
  eq([d.disputeCategory, d.patches[0].patch.status_note], ['other', 'Dispute, reason unclear']);
  const long = plan({ cls: cls({ intent: 'dispute', dispute_category: 'wrong_amount', dispute_reason: 'x'.repeat(300) }) });
  assert(long.patches[0].patch.status_note.length <= 300);
});
test('policy: every reason gives its own headline and checklist', () => {
  const heads = new Set();
  for (const c of DS.CATEGORIES) {
    const d = plan({ cls: cls({ intent: 'dispute', dispute_category: c }) });
    eq(d.disputeCategory, c); eq(d.alert.extraLines, DS.disputeLines(c)); heads.add(d.alert.headline);
  }
  eq(heads.size, 8);
});
test('policy: nothing else gets a checklist, and the safety rules still come first', () => {
  eq(plan({ cls: cls({ intent: 'cannot_pay' }) }).alert.extraLines, undefined);
  eq(plan({ cls: cls({ intent: 'promise_to_pay', promised_date: '2026-11-27' }) }).alert, null);
  const legal = plan({ safety: 'legal', cls: cls({ intent: 'dispute', dispute_category: 'wrong_amount' }) });
  eq([legal.label, legal.alert.extraLines, legal.disputeCategory], ['stopped_legal', undefined, undefined]);
  const unsure = plan({ cls: cls({ intent: 'dispute', dispute_category: 'wrong_amount', confidence: 0.3 }) });
  eq([unsure.label, unsure.alert.extraLines, unsure.patches[0].patch.status], ['low_confidence', undefined, 'on_hold']);
  const stranger = plan({ senderKnown: false, cls: cls({ intent: 'dispute', dispute_category: 'wrong_amount' }) });
  eq([stranger.label, stranger.patches.length, stranger.alert.extraLines], ['unverified_sender', 0, undefined]);
});

console.log(failures.length ? failures.join('\n') : '');
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
