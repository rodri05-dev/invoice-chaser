// Every tunable lives here and comes from environment variables, so redeploying for a new
// client is a settings change (Appendix C), not a code change.
const num = (v, d) => (v === undefined || v === null || String(v).trim() === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d = false) => (v === undefined || v === null || String(v).trim() === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const list = (v, d) => (v && String(v).trim() ? String(v).split(',').map(s => s.trim()).filter(Boolean) : d);

const TONES = ['friendly', 'follow_up', 'firm', 'final'];

// offsetDays = days AFTER the due date. Edit here, or override with SEQUENCE_JSON (Appendix C).
const DEFAULT_SEQUENCE = [
  { key: 'friendly',  offsetDays: 1,  tone: 'friendly',  sms: false },
  { key: 'follow_up', offsetDays: 7,  tone: 'follow_up', sms: false },
  { key: 'firm',      offsetDays: 14, tone: 'firm',      sms: true  },
  { key: 'final',     offsetDays: 21, tone: 'final',     sms: true  }
];

function loadSequence(raw) {
  if (!raw || !String(raw).trim()) return DEFAULT_SEQUENCE;
  try {
    const arr = JSON.parse(raw);
    const ok = Array.isArray(arr) && arr.length > 0 && arr.every(s => s && Number.isFinite(Number(s.offsetDays)) && TONES.includes(s.tone));
    if (!ok) throw new Error('needs an array of { offsetDays, tone } where tone is one of ' + TONES.join(', '));
    return arr
      .map((s, i) => ({ key: s.key || `${s.tone}_${i}`, offsetDays: Number(s.offsetDays), tone: s.tone, sms: s.sms === true }))
      .sort((a, b) => a.offsetDays - b.offsetDays);
  } catch (e) {
    console.warn('SEQUENCE_JSON ignored, using the default sequence:', e.message);
    return DEFAULT_SEQUENCE;
  }
}

function getConfig(env = process.env) {
  const name = env.BUSINESS_NAME || 'Our Company';
  return {
    // SAFETY: anything that would email a customer is only logged until you set DRY_RUN=false.
    dryRun: bool(env.DRY_RUN, true),
    // While testing, every customer email/SMS is redirected to you instead of the real customer.
    testEmailOverride: (env.TEST_EMAIL_OVERRIDE || '').trim() || null,
    testSmsOverride: (env.TEST_SMS_OVERRIDE || '').trim() || null,
    business: {
      name,
      timezone: env.BUSINESS_TIMEZONE || 'America/New_York',
      locale: env.BUSINESS_LOCALE || 'en-US',
      currency: (env.DEFAULT_CURRENCY || 'USD').toUpperCase(),
      senderName: env.SENDER_NAME || `${name} Accounts`,
      signOff: env.SIGN_OFF_NAME || 'Accounts Receivable',
      paymentInstructions: (env.PAYMENT_INSTRUCTIONS || '').replace(/\\n/g, '\n').trim(),
      lateFeeNote: (env.LATE_FEE_NOTE || '').trim(),
      ownerEmail: (env.OWNER_EMAIL || env.GMAIL_ADDRESS || '').trim()
    },
    appDomain: (env.APP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    send: {
      days: list(env.SEND_DAYS, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']),
      hourStart: num(env.SEND_HOUR_START, 9),
      hourEnd: num(env.SEND_HOUR_END, 17),
      maxPerRun: num(env.MAX_SENDS_PER_RUN, 15)
    },
    sequence: loadSequence(env.SEQUENCE_JSON),
    minGapDays: num(env.MIN_GAP_DAYS, 5),               // never email the same customer more often than this
    escalateGapDays: num(env.ESCALATE_GAP_DAYS, 7),     // after the last step, wait this long, then hand to you
    promiseGraceDays: num(env.PROMISE_GRACE_DAYS, 2),   // days after a promised date before chasing resumes
    maxPromiseDays: num(env.MAX_PROMISE_DAYS, 60),      // a promise further out than this is not believed
    maxPromises: num(env.MAX_PROMISES, 2),              // after this many broken promises, a human takes over
    decisionHoldDays: num(env.DECISION_HOLD_DAYS, 7),   // pause while you decide on an extension/plan request
    minConfidence: num(env.MIN_CONFIDENCE, 0.6),        // below this the AI's reading is not acted on
    autoAck: bool(env.AUTO_ACK, true),                  // send the fixed "thanks, noted" replies
    notifyOnPromise: bool(env.NOTIFY_ON_PROMISE, false),
    notifyOnSend: bool(env.NOTIFY_ON_SEND, true),       // one summary email whenever a run sends reminders
    alertUnmatched: bool(env.ALERT_UNMATCHED, true),
    sms: { enabled: bool(env.SMS_ENABLED, false) }
  };
}

module.exports = { getConfig, TONES, DEFAULT_SEQUENCE };