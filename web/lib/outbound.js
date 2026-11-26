// The ONLY place customer-facing messages leave the system. Every safety switch lives here:
// DRY_RUN (log only) and TEST_EMAIL_OVERRIDE / TEST_SMS_OVERRIDE (redirect to you).
const { supabase, must } = require('./db');
const { getConfig } = require('./config');
const mail = require('./mail');
const { sendSms } = require('./sms');

async function logOutbound(row) {
  const { error } = await supabase.from('outbound_messages').insert(row);
  if (error) console.error('logOutbound failed:', error.message);
}

// Replies to "you+<token>@gmail.com" still land in your inbox, and the token tells us which customer wrote.
// Where plus-addresses are not safe (the free Outlook.com may not accept them), no Reply-To is set and the reply is
// matched by the email thread instead (see match.js).
async function replyToFor(customer, cfg) {
  if (!mail.plusAddressing()) return undefined;
  const [local, domain] = String(await mail.mailboxAddress()).split('@');
  if (!local || !domain) return undefined;
  return `"${cfg.business.senderName.replace(/"/g, '')}" <${local}+${customer.reply_token}@${domain}>`;
}

// replyToGraphId: the Microsoft id of the customer's message. When given (Microsoft only), the acknowledgement is sent
// as a reply inside that thread. The recipient is still decided HERE, so TEST_EMAIL_OVERRIDE always applies.
async function sendCustomerEmail({ cfg = getConfig(), customer, to, subject, text, html, kind, invoiceIds = [], stepKey = null, tone = null, inReplyTo, references, replyToGraphId }) {
  const actualTo = cfg.testEmailOverride || to;
  const subj = cfg.testEmailOverride ? `[TEST for ${to}] ${subject}` : subject;
  const row = { kind, channel: 'email', customer_id: customer.id, invoice_ids: invoiceIds, to_address: actualTo, subject: subj, body_text: text, step_key: stepKey, tone };
  if (cfg.dryRun) { await logOutbound({ ...row, status: 'dry_run' }); return { ok: true, dryRun: true }; }
  try {
    const sent = replyToGraphId && mail.provider() === 'graph'
      ? await mail.sendReply({ graphMessageId: replyToGraphId, to: actualTo, text, html })
      : await mail.sendMail({ fromName: cfg.business.senderName, to: actualTo, subject: subj, text, html, replyTo: await replyToFor(customer, cfg), inReplyTo, references });
    await logOutbound({
      ...row, status: 'sent', message_id: sent.messageId,
      ...(sent.graphMessageId ? { graph_message_id: sent.graphMessageId } : {}), ...(sent.conversationId ? { conversation_id: sent.conversationId } : {})
    });
    return { ok: true, messageId: sent.messageId };
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
// If the Outlook connection has broken, an alert can still reach you through Gmail, when Gmail is set up as a backup.
async function sendOwnerEmail({ kind = 'owner_alert', subject, text, html }) {
  const cfg = getConfig();
  const fromName = `${cfg.business.name} Invoice Chaser`;
  const row = { kind, channel: 'email', to_address: cfg.business.ownerEmail, subject, body_text: text };
  try {
    const { messageId } = await mail.sendMail({ fromName, to: cfg.business.ownerEmail, subject, text, html });
    await logOutbound({ ...row, status: 'sent', message_id: messageId });
    return { ok: true };
  } catch (e) {
    if (e instanceof mail.MailAuthError && process.env.GMAIL_ADDRESS && process.env.GMAIL_APP_PASSWORD) {
      try {
        const { messageId } = await require('./gmail').sendMail({ fromName, to: cfg.business.ownerEmail, subject, text, html });
        await logOutbound({ ...row, status: 'sent', message_id: messageId, error: 'sent by the Gmail backup because the Outlook connection needs reconnecting' });
        return { ok: true, backup: 'gmail' };
      } catch (e2) { /* the backup failed too: report the first problem below */ }
    }
    await logOutbound({ ...row, status: 'failed', error: String(e.message).slice(0, 300) });
    console.error('owner email failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { sendCustomerEmail, sendCustomerSms, sendOwnerEmail };
