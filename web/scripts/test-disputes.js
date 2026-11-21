// node scripts/test-disputes.js  — checks the dispute reasons, the fixed checklists, the classify changes,
// the policy plan for a dispute, and the dispute tasks and buttons (run against a tiny in-memory stand-in
// for the database). No real database, email or AI involved.
process.env.GMAIL_ADDRESS = 'chaser@example.com';

const assert = require('assert');

// ---- a tiny in-memory stand-in for Supabase, used only by this test ----
// the real table fills in these columns by itself (see db/ic3-tasks.sql), so the stand-in does too
const DEFAULTS = { tasks: { status: 'open', type: 'dispute' } };
function makeFakeDb(tables, brokenTables = []) {
  let n = 0;
  const from = name => {
    let op = 'select', filters = [], payload = null, one = false, after = false;
    const api = {
      select() { after = true; return api; },
      insert(p) { op = 'insert'; payload = p; return api; },
      update(p) { op = 'update'; payload = p; return api; },
      eq(c, v) { filters.push(r => r[c] === v); return api; },
      neq(c, v) { filters.push(r => r[c] !== v); return api; },
      in(c, vs) { filters.push(r => vs.includes(r[c])); return api; },
      like(c, pat) { const re = new RegExp('^' + pat.replace(/%/g, '.*') + '$'); filters.push(r => re.test(String(r[c] || ''))); return api; },
      limit() { return api; },
      single() { one = true; return api; },
      maybeSingle() { one = true; return api; },
      then(resolve, reject) {
        if (brokenTables.includes(name)) return Promise.resolve({ data: null, error: { message: `relation "${name}" does not exist` } }).then(resolve, reject);
        const rows = tables[name] = tables[name] || [];
        const hit = rows.filter(r => filters.every(f => f(r)));
        let data;
        if (op === 'insert') { const row = { id: `${name}-${++n}`, ...(DEFAULTS[name] || {}), ...payload }; rows.push(row); data = after ? (one ? row : [row]) : null; }
        else if (op === 'update') { hit.forEach(r => Object.assign(r, payload)); data = after ? (one ? hit[0] : hit) : null; }
        else data = one ? hit[0] || null : hit;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      }
    };
    return api;
  };
  return { from };
}
const must = ({ data, error }) => { if (error) throw new Error(error.message || String(error)); return data; };
let TABLES = {}, BROKEN = [];
const fakeDb = { from: name => makeFakeDb(TABLES, BROKEN).from(name) };
const logEvent = async ({ invoiceId = null, customerId = null, type, details = {} }) => { (TABLES.events = TABLES.events || []).push({ invoice_id: invoiceId, customer_id: customerId, type, details }); };
require.cache[require.resolve('../lib/db')] = { id: require.resolve('../lib/db'), filename: require.resolve('../lib/db'), loaded: true, exports: { supabase: fakeDb, must, fetchAll: async () => [], logEvent } };

const { getConfig } = require('../lib/config');
const C = require('../lib/classify');
const { decide } = require('../lib/policy');
const DS = require('../lib/disputes');
const { openDisputeTask, updateTasks } = require('../lib/tasks');
const { performAction, ACTIONS } = require('../lib/actions');

let passed = 0; const failures = [];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const eq = assert.deepStrictEqual;

const TODAY = '2026-11-20';
const NOW_ISO = '2026-11-20T10:00:00.000Z';
const cfg = getConfig({ BUSINESS_NAME: 'Acme Ltd', OWNER_EMAIL: 'owner@acme.example' });
const cust = { id: 'c1', name: 'Brindley Ltd', contact_name: 'Sam', email: 'ap@brindley.example' };
const inv = (o = {}) => ({ id: 'i1', invoice_number: 'INV-9', amount_cents: 125000, amount_paid_cents: 0, currency: 'GBP', status: 'open', due_date: '2026-11-01', customers: cust, ...o });
const cls = o => C.normalize({ confidence: 0.95, sentiment: 'neutral', ...o });
const plan = (o = {}) => decide({ cls: cls({ intent: 'dispute' }), safety: null, customer: cust, targets: [inv()], allActive: [inv()], senderKnown: true, cfg, today: TODAY, nowISO: NOW_ISO, ...o });
const fresh = (invoiceStatus = 'disputed', broken = []) => { TABLES = { invoices: [{ id: 'i1', customer_id: 'c1', invoice_number: 'INV-9', amount_cents: 125000, amount_paid_cents: 0, status: invoiceStatus, status_note: 'PO number missing' }], customers: [{ id: 'c1' }], tasks: [], routing_rules: [], events: [] }; BROKEN = broken; };
const openTasks = () => TABLES.tasks.filter(t => ['open', 'waiting_on_customer', 'credit_note_needed'].includes(t.status));

// ---------- reasons and checklists ----------
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

// ---------- classify ----------
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

// ---------- policy ----------
test('policy: a dispute stores the reason, pauses chasing, asks for a task and adds the checklist', () => {
  const d = plan({ cls: cls({ intent: 'dispute', dispute_category: 'missing_po', dispute_reason: 'Need a PO number' }) });
  eq([d.label, d.disputeCategory, d.alert.level, d.ack], ['disputed', 'missing_po', 'urgent', null]);
  eq(d.patches[0].patch.status, 'disputed'); eq(d.patches[0].patch.paused_until, null);
  assert(d.patches[0].patch.status_note.startsWith('PO number missing') && d.patches[0].patch.status_note.includes('Need a PO number'));
  eq(d.patches[0].event, { type: 'disputed', details: { reason: 'Need a PO number', category: 'missing_po' } });
  eq(d.task, { type: 'dispute', category: 'missing_po', note: d.patches[0].patch.status_note });
  assert(d.alert.headline.includes('INV-9') && d.alert.headline.includes('PO number missing'));
  eq(d.alert.actions.map(a => a.action), ['evidence_sent', 'resume', 'credit_note_needed', 'mark_paid', 'void']);
  eq(d.alert.extraLines, DS.disputeLines('missing_po'));
});
test('policy: every button on a dispute alert is a real action', () => {
  for (const a of plan().alert.actions) assert(ACTIONS.includes(a.action), a.action);
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
    eq(d.disputeCategory, c); eq(d.alert.extraLines, DS.disputeLines(c)); eq(d.task.category, c); heads.add(d.alert.headline);
  }
  eq(heads.size, 8);
});
test('policy: nothing else gets a checklist or a task, and the safety rules still come first', () => {
  const other = plan({ cls: cls({ intent: 'cannot_pay' }) }); eq([other.alert.extraLines, other.task], [undefined, undefined]);
  eq(plan({ cls: cls({ intent: 'promise_to_pay', promised_date: '2026-11-27' }) }).alert, null);
  const legal = plan({ safety: 'legal', cls: cls({ intent: 'dispute', dispute_category: 'wrong_amount' }) });
  eq([legal.label, legal.alert.extraLines, legal.task], ['stopped_legal', undefined, undefined]);
  const unsure = plan({ cls: cls({ intent: 'dispute', dispute_category: 'wrong_amount', confidence: 0.3 }) });
  eq([unsure.label, unsure.alert.extraLines, unsure.task, unsure.patches[0].patch.status], ['low_confidence', undefined, undefined, 'on_hold']);
  const stranger = plan({ senderKnown: false, cls: cls({ intent: 'dispute', dispute_category: 'wrong_amount' }) });
  eq([stranger.label, stranger.patches.length, stranger.task], ['unverified_sender', 0, undefined]);
});

// ---------- tasks and buttons ----------
test('tasks: a dispute opens one task for you, and a second reply updates it instead of adding another', async () => {
  fresh();
  const r1 = await openDisputeTask({ invoice: inv(), customer: cust, category: 'missing_po', note: 'PO number missing', cfg, today: TODAY });
  assert(r1.created); eq(TABLES.tasks.length, 1);
  eq([TABLES.tasks[0].category, TABLES.tasks[0].assignee_email, TABLES.tasks[0].status, TABLES.tasks[0].due_date, TABLES.tasks[0].type], ['missing_po', 'owner@acme.example', 'open', '2026-11-25', 'dispute']);
  TABLES.tasks[0].status = 'waiting_on_customer';
  const r2 = await openDisputeTask({ invoice: inv(), customer: cust, category: 'wrong_amount', note: 'Amount disputed', cfg, today: TODAY });
  assert(r2.updated); eq(TABLES.tasks.length, 1);
  eq([TABLES.tasks[0].category, TABLES.tasks[0].status], ['wrong_amount', 'open']);
});
test('tasks: a routing rule sends a reason to the person you named', async () => {
  fresh(); TABLES.routing_rules.push({ category: 'delivery_not_confirmed', assignee_email: 'warehouse@acme.example' });
  await openDisputeTask({ invoice: inv(), customer: cust, category: 'delivery_not_confirmed', note: 'x', cfg, today: TODAY });
  eq(TABLES.tasks[0].assignee_email, 'warehouse@acme.example');
});
test('buttons: "Evidence sent" and "Credit note needed" keep the invoice disputed and update the task', async () => {
  fresh(); await openDisputeTask({ invoice: inv(), customer: cust, category: 'missing_po', note: 'n', cfg, today: TODAY });
  await performAction({ action: 'evidence_sent', invoiceId: 'i1' });
  eq([TABLES.invoices[0].status, TABLES.tasks[0].status], ['disputed', 'waiting_on_customer']);
  assert(TABLES.invoices[0].status_note.startsWith('Evidence sent'));
  await performAction({ action: 'credit_note_needed', invoiceId: 'i1' });
  eq([TABLES.invoices[0].status, TABLES.tasks[0].status], ['disputed', 'credit_note_needed']);
  assert(TABLES.invoices[0].status_note.startsWith('Credit note needed'));
  eq(TABLES.events.map(e => e.type), ['evidence_sent', 'credit_note_needed']);
});
test('buttons: "Resolved — resume chasing" reopens the invoice and closes the task', async () => {
  fresh(); await openDisputeTask({ invoice: inv(), customer: cust, category: 'missing_po', note: 'n', cfg, today: TODAY });
  await performAction({ action: 'resume', invoiceId: 'i1' });
  eq([TABLES.invoices[0].status, TABLES.invoices[0].status_note, TABLES.tasks[0].status], ['open', null, 'resolved']);
  assert(TABLES.tasks[0].resolved_at); eq(openTasks().length, 0);
});
test('buttons: Void cancels the task and "Mark paid" resolves it', async () => {
  fresh(); await openDisputeTask({ invoice: inv(), customer: cust, category: 'other', note: 'n', cfg, today: TODAY });
  await performAction({ action: 'void', invoiceId: 'i1' });
  eq([TABLES.invoices[0].status, TABLES.tasks[0].status], ['void', 'cancelled']);
  fresh(); await openDisputeTask({ invoice: inv(), customer: cust, category: 'other', note: 'n', cfg, today: TODAY });
  await performAction({ action: 'mark_paid', invoiceId: 'i1' });
  eq([TABLES.invoices[0].status, TABLES.tasks[0].status], ['paid', 'resolved']);
});
test('buttons: the two dispute notes refuse an invoice that is not in dispute', async () => {
  fresh('open');
  await assert.rejects(() => performAction({ action: 'evidence_sent', invoiceId: 'i1' }), /not in dispute/);
  await assert.rejects(() => performAction({ action: 'credit_note_needed', invoiceId: 'i1' }), /not in dispute/);
  eq(TABLES.invoices[0].status, 'open');
});
test('tasks: a missing tasks table never breaks a button or a reply', async () => {
  fresh('disputed', ['tasks', 'routing_rules']);
  const r = await openDisputeTask({ invoice: inv(), customer: cust, category: 'other', note: 'n', cfg, today: TODAY });
  assert(r.error);
  await performAction({ action: 'resume', invoiceId: 'i1' });
  eq(TABLES.invoices[0].status, 'open');
  eq((await updateTasks('i1', 'resolved')).error !== undefined, true);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; } catch (e) { failures.push(`✗ ${name}\n    ${String(e.message).split("\n").slice(0, 14).join("\n")}`); }
  }
  console.log(failures.length ? failures.join('\n') : '');
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();