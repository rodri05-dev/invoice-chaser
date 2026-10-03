// Optional SMS channel. Twilio is loaded lazily, so the base system runs without the package installed.
async function sendSms({ to, body }) {
  const twilio = require('twilio');
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client.messages.create({ to, from: process.env.TWILIO_NUMBER, body });
}

module.exports = { sendSms };