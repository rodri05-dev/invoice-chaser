const mail = require('./mail');
const { processInbound } = require('./inbound');
const { alertOwner } = require('./notify');
const { getConfig } = require('./config');

async function pollInbox({ max = 15 } = {}) {
  let msgs;
  try {
    msgs = await mail.fetchUnread({ sinceDays: 5, max });
  } catch (e) {
    if (e instanceof mail.MailAuthError) {            // the Outlook sign-in is gone: tell the owner once a day how to fix it
      const domain = getConfig().appDomain;
      await alertOwner({
        level: 'urgent', key: 'mail_reconnect', dedupeHours: 24, headline: 'Your email connection needs to be reconnected',
        lines: ['The system cannot read replies or send reminders until you sign in to Microsoft again.', `Open https://${domain || 'your-app-address'}/api/mail/connect?secret=YOUR_CRON_CHECK_SECRET in your browser and sign in with the same mailbox.`, `Why it stopped: ${e.message}`]
      }).catch(err => console.error('could not send the reconnect alert:', err.message));
    }
    throw e;
  }
  const seen = [], results = [];
  for (const m of msgs) {
    if (m.tooLarge) { seen.push(m.uid); continue; }
    try {
      results.push(await processInbound({
        channel: 'email', messageId: m.messageId, from: m.from, to: m.to, subject: m.subject, text: m.text,
        receivedAt: m.date, headers: m.headers, references: m.references,
        conversationId: m.conversationId, graphMessageId: m.graphMessageId, inReplyTo: m.inReplyTo
      }));
    } catch (e) {
      console.error('processInbound failed:', e);
      results.push({ error: e.message });
      await alertOwner({ level: 'action', key: `inbound_fail:${m.messageId}`, dedupeHours: 24, headline: `Couldn't process a reply from ${m.from.address}`, lines: [`Subject: ${m.subject}`, `Error: ${e.message}`, '', String(m.text).slice(0, 600)] }).catch(() => {});
    }
    seen.push(m.uid);                // always mark read, so one bad email can never loop forever
  }
  await mail.markSeen(seen);
  return {
    fetched: msgs.length,
    replies: results.filter(r => r.kind === 'reply').length,
    autoReplies: results.filter(r => r.kind === 'auto_reply').length,
    bounces: results.filter(r => r.kind === 'bounce').length,
    unmatched: results.filter(r => r.kind === 'unmatched').length,
    errors: results.filter(r => r.error).length
  };
}

module.exports = { pollInbox };
