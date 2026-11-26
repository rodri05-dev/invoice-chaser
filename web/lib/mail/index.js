// The ONE door to email for the rest of the system. MAIL_PROVIDER picks the driver:
//   gmail (the default) = lib/gmail.js, exactly as before     graph = Microsoft Outlook / Microsoft 365 (lib/mail/graph.js)
// The graph driver is only loaded when it is chosen, so a problem in it can never affect a Gmail setup.
const gmail = require('../gmail');
const { MailAuthError } = require('./oauth');

const provider = () => (String(process.env.MAIL_PROVIDER || 'gmail').trim().toLowerCase() === 'graph' ? 'graph' : 'gmail');
const driver = () => (provider() === 'graph' ? require('./graph') : gmail);

const sendMail = opts => driver().sendMail(opts);
// A reply inside the customer's thread. Gmail has no such call: it is a normal send with In-Reply-To / References.
const sendReply = opts => (provider() === 'graph' ? require('./graph').sendReply(opts) : gmail.sendMail(opts));
const fetchUnread = opts => driver().fetchUnread(opts);
const markSeen = ids => driver().markSeen(ids);

let cached = { at: 0, address: '' };
async function mailboxAddress() {
  if (provider() === 'gmail') return String(process.env.GMAIL_ADDRESS || '').trim().toLowerCase();
  if (cached.address && Date.now() - cached.at < 5 * 60 * 1000) return cached.address;
  cached = { at: Date.now(), address: String(await require('./graph').mailboxAddress()).toLowerCase() };
  return cached.address;
}
const forgetMailbox = () => { cached = { at: 0, address: '' }; };

// "you+token@domain" reply addresses. Gmail and Microsoft 365 accept them; the free Outlook.com may not (a reply
// would bounce), so with Microsoft the default is OFF and replies are matched by the email thread instead.
function plusAddressing() {
  const v = process.env.MAIL_PLUS_ADDRESSING;
  if (v === undefined || String(v).trim() === '') return provider() === 'gmail';
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

module.exports = { provider, sendMail, sendReply, fetchUnread, markSeen, mailboxAddress, forgetMailbox, plusAddressing, MailAuthError };
