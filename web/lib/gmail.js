// One Gmail account does both jobs: sends the reminders (SMTP) and reads the replies (IMAP).
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { htmlToText } = require('./replytext');

let transporter;
const getTransporter = () =>
  (transporter = transporter || nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD } }));

async function sendMail({ fromName, to, cc, subject, text, html, replyTo, inReplyTo, references }) {
  const from = `"${String(fromName || '').replace(/["\r\n]/g, '')}" <${process.env.GMAIL_ADDRESS}>`;
  const info = await getTransporter().sendMail({ from, to, cc, subject, text, html, replyTo, inReplyTo, references });
  return { messageId: info.messageId };
}

const imap = () => new ImapFlow({
  host: 'imap.gmail.com', port: 993, secure: true, logger: false,
  auth: { user: process.env.GMAIL_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD }
});

const flat = v => (Array.isArray(v) ? v.flatMap(x => x.value || []) : v && v.value ? v.value : []);
const addrs = v => flat(v).map(a => String(a.address || '').toLowerCase()).filter(Boolean);

function shape(uid, p) {
  const h = name => { const v = p.headers.get(name); return Array.isArray(v) ? v.join(' ') : v && v.text ? v.text : String(v || ''); };
  const from = flat(p.from)[0] || {};
  return {
    uid,
    messageId: p.messageId || null,
    inReplyTo: p.inReplyTo || null,
    references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [],
    from: { address: String(from.address || '').toLowerCase(), name: from.name || '' },
    // every address the message was sent to, including the plus-address that carries our reply token
    to: [...addrs(p.to), ...addrs(p.cc), ...h('delivered-to').split(/[\s,]+/), ...h('x-original-to').split(/[\s,]+/)]
      .map(s => s.toLowerCase()).filter(s => s.includes('@')),
    subject: p.subject || '',
    text: (p.text || htmlToText(p.html || '') || '').trim(),
    date: p.date ? p.date.toISOString() : new Date().toISOString(),
    headers: { autoSubmitted: h('auto-submitted'), precedence: h('precedence'), xAutoreply: h('x-autoreply') || h('x-autorespond') }
  };
}

// Unread inbox mail from the last few days, fully parsed.
async function fetchUnread({ sinceDays = 5, max = 15 } = {}) {
  const client = imap();
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  const out = [];
  try {
    const since = new Date(Date.now() - sinceDays * 86400000);
    const uids = (await client.search({ seen: false, since }, { uid: true })) || [];
    for (const uid of uids.slice(0, max)) {
      const msg = await client.fetchOne(String(uid), { source: true, size: true }, { uid: true });
      if (!msg || !msg.source) continue;
      if (msg.size > 3000000) { out.push({ uid, tooLarge: true }); continue; }   // skip huge attachments
      out.push(shape(uid, await simpleParser(msg.source)));
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return out;
}

async function markSeen(uids) {
  if (!uids.length) return;
  const client = imap();
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try { await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true }); }   // { uid: true } matters: without it these are sequence numbers
  finally { lock.release(); await client.logout().catch(() => {}); }
}

module.exports = { sendMail, fetchUnread, markSeen };