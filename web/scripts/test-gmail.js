// node scripts/test-gmail.js  — proves the Gmail account can SEND (SMTP) and READ (IMAP).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sendMail } = require('../lib/gmail');
const { ImapFlow } = require('imapflow');

(async () => {
  await sendMail({ fromName: 'Invoice Chaser test', to: process.env.GMAIL_ADDRESS, subject: 'Invoice Chaser: SMTP test', text: 'If you can read this, sending works.' });
  console.log('✓ SMTP: test email sent to', process.env.GMAIL_ADDRESS);

  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, logger: false, auth: { user: process.env.GMAIL_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD } });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  console.log(`✓ IMAP: logged in, ${client.mailbox.exists} messages in INBOX`);
  lock.release();
  await client.logout();
})().catch(e => {
  console.error('✗', e.message);
  if (/self.signed|certificate/i.test(e.message)) console.error('  → antivirus "HTTPS scanning" is intercepting Node. Exclude node.exe from it.');
  if (/Invalid credentials|AUTHENTICATIONFAILED|BadCredentials|535/i.test(e.message)) console.error('  → regenerate the App Password (no spaces), and make sure 2-Step Verification is on.');
  if (/IMAP/i.test(e.message) && /disabled|not enabled/i.test(e.message)) console.error('  → Gmail → Settings → See all settings → Forwarding and POP/IMAP → enable IMAP.');
  process.exit(1);
});