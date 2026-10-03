const { fetchUnread, markSeen } = require('./gmail');
const { processInbound } = require('./inbound');
const { alertOwner } = require('./notify');

async function pollInbox({ max = 15 } = {}) {
  const msgs = await fetchUnread({ sinceDays: 5, max });
  const seen = [], results = [];
  for (const m of msgs) {
    if (m.tooLarge) { seen.push(m.uid); continue; }
    try {
      results.push(await processInbound({
        channel: 'email', messageId: m.messageId, from: m.from, to: m.to, subject: m.subject, text: m.text,
        receivedAt: m.date, headers: m.headers, references: m.references
      }));
    } catch (e) {
      console.error('processInbound failed:', e);
      results.push({ error: e.message });
      await alertOwner({ level: 'action', key: `inbound_fail:${m.messageId}`, dedupeHours: 24, headline: `Couldn't process a reply from ${m.from.address}`, lines: [`Subject: ${m.subject}`, `Error: ${e.message}`, '', String(m.text).slice(0, 600)] }).catch(() => {});
    }
    seen.push(m.uid);                // always mark read, so one bad email can never loop forever
  }
  await markSeen(seen);
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