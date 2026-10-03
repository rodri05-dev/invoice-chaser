// Test tools. OFF unless ENABLE_DEV_TOOLS=true, and always behind CRON_CHECK_SECRET. Remove the env var before going live.
//   /api/dev?tool=classify&secret=...&text=we+will+pay+on+Friday&invoice=INV-1001&amount=1250&overdue=15
//        -> what the AI reads and what the system would DO (touches no data)
//   /api/dev?tool=simulate&secret=...&from=ap@acme.com&subject=Re:+INV-1001&text=we+dispute+this
//        -> runs the full reply pipeline on a fake email (real database changes; customer emails go to TEST_EMAIL_OVERRIDE)
const { isCronAuthorized } = require('../lib/auth');
const { getConfig } = require('../lib/config');
const { todayISO, addDays } = require('../lib/dates');
const { toCents } = require('../lib/money');
const { safetyScan, classifyReply } = require('../lib/classify');
const { decide } = require('../lib/policy');
const { processInbound } = require('../lib/inbound');

module.exports = async (req, res) => {
  if (process.env.ENABLE_DEV_TOOLS !== 'true') return res.status(404).end();
  if (!isCronAuthorized(req)) return res.status(401).end();
  const q = { ...(req.query || {}), ...(req.body || {}) };
  const cfg = getConfig();
  const today = todayISO(cfg.business.timezone);

  try {
    if (q.tool === 'classify') {
      const target = {
        id: 'test', invoice_number: q.invoice || 'INV-1001', currency: cfg.business.currency, status: 'open',
        amount_cents: toCents(q.amount || 1250), amount_paid_cents: 0, due_date: addDays(today, -Number(q.overdue || 15)),
        promised_count: Number(q.promised || 0), invoice_url: q.url || null
      };
      const customer = { id: 'test', name: q.customer || 'Test Customer', contact_name: 'Jo' };
      const text = String(q.text || '');
      const safety = safetyScan(text);
      const cls = await classifyReply({ cfg, today, receivedISO: q.received || today, customer, invoices: [target], replyText: text });
      const decision = decide({ cls, safety, customer, targets: [target], allActive: [target], senderKnown: true, cfg, today, nowISO: new Date().toISOString() });
      return res.status(200).json({ safety, cls, decision: { label: decision.label, ack: decision.ack, alert: decision.alert && { level: decision.alert.level, headline: decision.alert.headline, buttons: decision.alert.actions.map(a => a.label) }, invoiceChanges: decision.patches.map(p => p.patch), customerChange: decision.customerPatch } });
    }
    if (q.tool === 'simulate') {
      const [local, domain] = String(process.env.GMAIL_ADDRESS || '').split('@');
      const result = await processInbound({
        channel: 'email', messageId: `sim-${Date.now()}`, from: { address: String(q.from || '').toLowerCase(), name: q.name || '' },
        to: q.token ? [`${local}+${q.token}@${domain}`] : [], subject: q.subject || 'Re: invoice', text: String(q.text || ''), receivedAt: new Date().toISOString()
      });
      return res.status(200).json(result);
    }
    return res.status(400).json({ error: 'tool must be classify or simulate' });
  } catch (e) {
    console.error('dev tool failed:', e);
    return res.status(500).json({ error: e.message });
  }
};