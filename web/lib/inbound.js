// The whole reply pipeline: email or SMS in -> matched -> read -> acted on -> logged.
const { supabase, must, logEvent } = require('./db');
const { getConfig } = require('./config');
const { todayISO } = require('./dates');
const { stripQuoted, isAutoReply, isBounce, extractEmails, cleanSubject } = require('./replytext');
const { matchInbound, loadCandidates, tokenFrom } = require('./match');
const { safetyScan, classifyReply } = require('./classify');
const { decide } = require('./policy');
const { renderAck } = require('./templates');
const { sendCustomerEmail } = require('./outbound');
const { alertOwner } = require('./notify');
const { formatMoney, balanceCents } = require('./money');

function ownerLines({ customer, targets, cfg, cls, text }) {
  const inv = targets.map(t => `${t.invoice_number} (${formatMoney(balanceCents(t), t.currency || cfg.business.currency, cfg.business.locale)}, due ${t.due_date})`).join('; ');
  const lines = [`Customer: ${customer.name}`, `Invoices: ${inv || 'none open'}`, '', `What they wrote: "${String(text).replace(/\s+/g, ' ').slice(0, 600)}"`, '',
    `AI reading: ${cls.intent.replace(/_/g, ' ')} (${Math.round(cls.confidence * 100)}% sure) — ${cls.summary}`];
  if (cls.suggested_reply) lines.push('', 'Suggested reply (edit before sending):', cls.suggested_reply);
  return lines;
}

// msg: { channel, messageId, from: {address,name}, fromPhone, to: [], subject, text, receivedAt, headers, references }
async function processInbound(msg) {
  const cfg = getConfig();
  const channel = msg.channel || 'email';
  const nowISO = new Date().toISOString();
  const today = todayISO(cfg.business.timezone);
  const from = String((msg.from && msg.from.address) || '').toLowerCase();
  const messageId = msg.messageId || `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const own = String(process.env.GMAIL_ADDRESS || '').toLowerCase();

  if (channel === 'email' && from && from === own && !tokenFrom(msg.to || [])) return { skipped: 'own_message' };   // our own mail landing in the inbox

  if (must(await supabase.from('inbound_messages').select('id').eq('message_id', messageId).maybeSingle())) return { duplicate: true };

  const base = { channel, message_id: messageId, from_address: from || msg.fromPhone || null, from_name: (msg.from && msg.from.name) || null, subject: msg.subject || null, received_at: msg.receivedAt || nowISO };
  const save = async extra => must(await supabase.from('inbound_messages').insert({ ...base, ...extra }));

  // 1) delivery failures and out-of-office replies are not replies
  if (channel === 'email' && isBounce({ from, subject: msg.subject })) {
    const emails = extractEmails(msg.text);
    const hit = emails.length ? must(await supabase.from('customers').select('*').in('email', emails)) : [];
    for (const c of hit) {
      must(await supabase.from('customers').update({ email_bounced: true }).eq('id', c.id));
      await alertOwner({ level: 'action', key: `bounce:${c.id}`, dedupeHours: 24, customer: c, headline: `Email to ${c.name} bounced (${c.email})`, lines: ['Reminders to this address are paused. Fix the address on the dashboard, or use the button below.'] });
    }
    if (!hit.length) await alertOwner({ level: 'info', key: `bounce:${messageId}`, headline: 'A delivery-failure notice arrived that we could not match to a customer', lines: [String(msg.text).slice(0, 500)] });
    await save({ kind: 'bounce', body_text: String(msg.text || '').slice(0, 1000), customer_id: hit[0] ? hit[0].id : null, action_taken: hit.length ? 'marked_bounced' : 'unmatched_bounce' });
    return { kind: 'bounce', customers: hit.length };
  }
  if (channel === 'email' && isAutoReply({ subject: msg.subject, headers: msg.headers || {}, from })) {
    await save({ kind: 'auto_reply', body_text: String(msg.text || '').slice(0, 500), action_taken: 'ignored' });
    return { kind: 'auto_reply' };
  }

  // 2) who is this, and what did they actually write?
  const text = channel === 'sms' ? String(msg.text || '').trim() : stripQuoted(msg.text) || String(msg.text || '').slice(0, 1500);
  const m = await matchInbound({ channel, fromEmail: from, fromPhone: msg.fromPhone, toAddresses: msg.to || [], subject: msg.subject, body: text });
  if (!m.customer) {
    await save({ kind: 'unmatched', body_text: text.slice(0, 2000), needs_human: true, action_taken: cfg.alertUnmatched ? 'owner_alerted' : 'ignored' });
    if (cfg.alertUnmatched) await alertOwner({ level: 'action', key: `unmatched:${messageId}`, headline: `A reply from ${from || msg.fromPhone || 'someone'} doesn't match any customer`, lines: [`Subject: ${msg.subject || '(none)'}`, '', text.slice(0, 800)] });
    return { kind: 'unmatched' };
  }

  // 3) read it, then let the policy table decide
  const { targets, allActive } = await loadCandidates(m.customer, { text, subject: msg.subject });
  const safety = safetyScan(text);
  const receivedISO = todayISO(cfg.business.timezone, new Date(msg.receivedAt || nowISO));
  const cls = await classifyReply({ cfg, today, receivedISO, customer: m.customer, invoices: targets, replyText: text });
  const d = decide({ cls, safety, customer: m.customer, targets, allActive, senderKnown: m.senderKnown, cfg, today, nowISO });

  for (const p of d.patches) {
    must(await supabase.from('invoices').update(p.patch).eq('id', p.invoiceId));
    await logEvent({ invoiceId: p.invoiceId, customerId: m.customer.id, type: p.event.type, details: { ...p.event.details, from_reply: true } });
  }
  if (d.customerPatch) must(await supabase.from('customers').update(d.customerPatch).eq('id', m.customer.id));

  // 4) the fixed acknowledgement (at most one per customer per 24h, so two auto-responders can never loop)
  let ackNote = null;
  if (d.ack && channel === 'email') {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const recent = must(await supabase.from('outbound_messages').select('id').eq('customer_id', m.customer.id).eq('kind', 'ack').gte('created_at', since).limit(1));
    if (recent.length) ackNote = 'ack_suppressed';
    else {
      const ack = renderAck({ kind: d.ack.kind, customer: m.customer, invoices: targets, date: d.ack.date, cfg, today });
      const r = await sendCustomerEmail({
        cfg, customer: m.customer, to: from || m.customer.email, kind: 'ack', invoiceIds: targets.map(t => t.id),
        subject: `Re: ${cleanSubject(msg.subject) || 'your invoice'}`, text: ack.text, html: ack.html,
        inReplyTo: msg.messageId, references: [...(msg.references || []), msg.messageId].filter(Boolean)
      });
      ackNote = r.ok ? 'ack_sent' : 'ack_failed';
    }
    if (ackNote !== 'ack_sent' && !d.alert && !cfg.dryRun) d.alert = { level: 'action', key: 'ack_problem', headline: `${m.customer.name} replied and no acknowledgement went out (${ackNote})`, actions: [] };
  }

  // 5) tell the owner when a human is needed
  if (d.alert) {
    await alertOwner({ level: d.alert.level, key: `${d.alert.key}:${messageId}`, headline: d.alert.headline, lines: ownerLines({ customer: m.customer, targets, cfg, cls, text }), actions: d.alert.actions, invoice: targets[0], customer: m.customer });
  }

  await save({
    customer_id: m.customer.id, invoice_ids: targets.map(t => t.id), match_method: m.method, kind: 'reply', body_text: text.slice(0, 2000),
    intent: cls.intent, confidence: cls.confidence, ai_result: cls, needs_human: !!(d.alert && d.alert.level !== 'info'),
    action_taken: [d.label, ackNote].filter(Boolean).join(' + ')
  });
  return { kind: 'reply', customer: m.customer.name, intent: cls.intent, confidence: cls.confidence, action: d.label, ack: ackNote, alerted: !!d.alert };
}

module.exports = { processInbound };