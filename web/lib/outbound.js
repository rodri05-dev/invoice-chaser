// The ONLY place customer-facing messages leave the system. Every safety switch lives here:
// DRY_RUN (log only) and TEST_EMAIL_OVERRIDE / TEST_SMS_OVERRIDE (redirect to you).
const { supabase, must } = require('./db');
const { getConfig } = require('./config');
const { sendMail } = require('./gmail');
const { sendSms } = require('./sms');

async function logOutbound(row) {
  const { error } = await supabase.from('outbound_messages').insert(row);
  if (error) console.error('logOutbound failed:', error.message);
}

// Replies to "you+<token>@gmail.com" still land in your inbox, and the token tells us which customer wrote.
function replyToFor(customer, cfg) {
  const [local, domain] = String(process.env.GMAIL_ADDRESS || '').split('@');
  return `"${cfg.business.senderName.replace(/"/g, '')}" <${local}+${customer.reply_token}@${domain}>`;
}

async function sendCustomerEmail({ cfg = getConfig(), customer, to, subject, text, html, kind, invoiceIds = [], stepKey = null, tone = null, inReplyTo, references }) {
  const actualTo = cfg.testEmailOverride || to;
  const subj = cfg.testEmailOverride ? `[TEST for ${to}] ${subject}` : subject;
  const row = { kind, channel: 'email', customer_id: customer.id, invoice_ids: invoiceIds, to_address: actualTo, subject: subj, body_text: text, step_key: stepKey, tone };
  if (cfg.dryRun) { await logOutbound({ ...row, status: 'dry_run' }); return { ok: true, dryRun: true }; }
  try {
    const { messageId } = await sendMail({ fromName: cfg.business.senderName, to: actualTo, subject: subj, text, html, replyTo: replyToFor(customer, cfg), inReplyTo, references });
    await logOutbound({ ...row, status: 'sent', message_id: messageId });
    return { ok: true, messageId };
  } catch (e) {
    await logOutbound({ ...row, status: 'failed', error: String(e.message).slice(0, 300) });
    return { ok: false, error: e.message };
  }
}

async function sendCustomerSms({ cfg = getConfig(), customer, body, invoiceIds = [], stepKey = null, tone = null }) {
  const to = cfg.testSmsOverride || customer.phone;
  const row = { kind: 'reminder', channel: 'sms', customer_id: customer.id, invoice_ids: invoiceIds, to_address: to, body_text: body, step_key: stepKey, tone };
  if (cfg.dryRun) { await logOutbound({ ...row, status: 'dry_run' }); return { ok: true, dryRun: true }; }
  try {
    const r = await sendSms({ to, body });
    await logOutbound({ ...row, status: 'sent', message_id: r.sid });
    return { ok: true };
  } catch (e) {
    await logOutbound({ ...row, status: 'failed', error: String(e.message).slice(0, 300) });
    return { ok: false, error: e.message };
  }
}

// Mail to YOU (alerts, weekly report). Sent even in dry-run mode: it never reaches a customer.
async function sendOwnerEmail({ kind = 'owner_alert', subject, text, html }) {
  const cfg = getConfig();
  const row = { kind, channel: 'email', to_address: cfg.business.ownerEmail, subject, body_text: text };
  try {
    const { messageId } = await sendMail({ fromName: `${cfg.business.name} Invoice Chaser`, to: cfg.business.ownerEmail, subject, text, html });
    await logOutbound({ ...row, status: 'sent', message_id: messageId });
    return { ok: true };
  } catch (e) {
    await logOutbound({ ...row, status: 'failed', error: String(e.message).slice(0, 300) });
    console.error('owner email failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { sendCustomerEmail, sendCustomerSms, sendOwnerEmail };