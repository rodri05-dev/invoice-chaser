// node scripts/eval-replies.js [--quick]
// Measures how well the AI reads customer replies, using realistic UK replies with known answers.
//   --quick   runs about a third of the AI cases (about 3 minutes instead of 8)
// It uses about 1,500 Groq tokens per AI case and waits 12 seconds between cases (Groq's free limit is
// 8,000 tokens a minute). It tests ONE model: the fallback is switched off for this test.
// To test the fallback model instead (PowerShell):  $env:GROQ_CHAT_MODEL='openai/gpt-oss-20b'; node scripts/eval-replies.js
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch (e) { /* use real environment variables */ }
process.env.MODEL_FALLBACKS = process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b';

const { getConfig } = require('../lib/config');
const { safetyScan, classifyReply } = require('../lib/classify');
const { modelList } = require('../lib/groq');

const TODAY = '2026-11-18';                       // a Wednesday: Thu 19th, Fri 20th, Wed 25th, Fri 27th, Mon 30th
const GAP_MS = Number(process.env.EVAL_GAP_MS ?? 12000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// t = what the customer wrote. intent = the right reading. alt = other acceptable readings.
// date = the right promised date ('any' = any date or none is fine, null = must be none).
// safety = a case for the plain-code safety net only (no AI call).
const CASES = [
  { t: 'Hi, apologies for the delay. We will pay this on Friday.', intent: 'promise_to_pay', date: '2026-11-20' },
  { t: 'Payment will be made by BACS on the 25th.', intent: 'promise_to_pay', date: '2026-11-25' },
  { t: "It's in our next payment run, which goes out on Thursday.", intent: 'promise_to_pay', date: '2026-11-19' },
  { t: 'Cheque is in the post, it should reach you early next week.', intent: 'promise_to_pay', date: 'any' },
  { t: 'We will settle this at the end of the month.', intent: 'promise_to_pay', date: '2026-11-30' },
  { t: 'Will pay tomorrow, sorry for the hold up.', intent: 'promise_to_pay', date: '2026-11-19' },
  { t: 'Our finance team will pay this soon.', intent: 'promise_to_pay', date: null },
  { t: 'Funds will leave our account on 27/11/2026.', intent: 'promise_to_pay', date: '2026-11-27' },
  { t: 'This was paid by bank transfer on the 12th.', intent: 'already_paid' },
  { t: 'We paid this last week via Faster Payments, ref FP123456.', intent: 'already_paid' },
  { t: 'Payment was made on 05/11/2026, please check your account.', intent: 'already_paid' },
  { t: 'Cheque sent two weeks ago, did you not get it?', intent: 'already_paid' },
  { t: 'Already settled, see the attached remittance.', intent: 'already_paid' },
  { t: "We're disputing this invoice. The work was never completed.", intent: 'dispute' },
  { t: 'The amount is wrong. We agreed £800, not £1,250.', intent: 'dispute' },
  { t: 'We never received the goods.', intent: 'dispute' },
  { t: "This isn't our invoice, we have no account with you.", intent: 'dispute' },
  { t: "We can't pay until you send a credit note for the faulty units.", intent: 'dispute' },
  { t: 'The VAT on this looks incorrect, can you reissue it?', intent: 'dispute', alt: ['needs_invoice_copy'] },
  { t: 'Could we have until the 30th to pay this?', intent: 'extension_request', date: '2026-11-30' },
  { t: 'Can you give us a few more weeks please?', intent: 'extension_request', date: null },
  { t: 'Please can we pay in December? Cash flow is tight this month.', intent: 'extension_request', alt: ['cannot_pay', 'payment_plan_request'] },
  { t: 'Could we pay this in three monthly instalments?', intent: 'payment_plan_request' },
  { t: 'We can pay half now and the rest in January.', intent: 'payment_plan_request' },
  { t: "We're really struggling at the moment and can't pay this right now.", intent: 'cannot_pay' },
  { t: "Sorry, we don't have the funds this month.", intent: 'cannot_pay', alt: ['extension_request'] },
  { t: "Can you resend the invoice? We can't find it.", intent: 'needs_invoice_copy' },
  { t: 'Please send a VAT invoice and your bank details.', intent: 'needs_invoice_copy' },
  { t: 'We need the PO number on this invoice before we can pay.', intent: 'needs_invoice_copy', alt: ['dispute'] },
  { t: "I don't deal with invoices any more. Please send these to accounts@brindley-test.example.", intent: 'wrong_contact' },
  { t: 'Wrong person, try our finance department.', intent: 'wrong_contact' },
  { t: 'I work in administration, not accounts. Try ap@brindley-test.example.', intent: 'wrong_contact' },
  { t: "Thanks, we'll look into it.", intent: 'acknowledged' },
  { t: 'Received, thank you.', intent: 'acknowledged' },
  { t: "Noted. I've passed it to accounts.", intent: 'acknowledged' },
  { t: 'Our office administrator is looking at it today.', intent: 'acknowledged' },
  { t: 'Is Jo still the right person to speak to about orders?', intent: 'other', alt: ['acknowledged'] },
  { t: 'Do you also do web design?', intent: 'other' },
  // safety net only (plain code, no AI):
  { t: 'Please pass this to our solicitor.', safety: 'legal' },
  { t: 'We have gone into administration.', safety: 'bankruptcy' },
  { t: 'The company is in liquidation, please contact the liquidators.', safety: 'bankruptcy' },
  { t: "We're a small firm and have gone bust.", safety: 'bankruptcy' },
  { t: 'We have appointed administrators.', safety: 'bankruptcy' },
  { t: 'You may hear from us about a CCJ.', safety: 'legal' },
  { t: "I'll be reporting this to Trading Standards.", safety: 'legal' },
  { t: 'Please stop sending me these emails.', safety: 'stop' },
  { t: 'Please treat this as a subject access request.', safety: 'stop' },
  { t: 'I want to opt out of these emails.', safety: 'stop' }
];

const QUIET = ['promise_to_pay', 'acknowledged'];   // readings that do not alert the owner

async function main() {
  const quick = process.argv.includes('--quick');
  const cases = CASES.filter((c, i) => c.safety !== undefined || !quick || i % 3 === 0);
  const aiCases = cases.filter(c => c.safety === undefined);
  const model = modelList()[0];
  console.log(`Model: ${model}. ${aiCases.length} AI cases + ${cases.length - aiCases.length} safety-net cases.`);
  if (GAP_MS > 0) console.log(`About ${Math.ceil(aiCases.length * (GAP_MS / 1000 + 3) / 60)} minutes (waiting between cases for Groq's free limit).\n`);

  const cfg = getConfig();
  const customer = { id: 'eval', name: 'Brindley Construction Ltd', contact_name: 'Sam' };
  const invoice = { id: 'eval-inv', invoice_number: 'INV-5003', currency: 'GBP', status: 'open', amount_cents: 125000, amount_paid_cents: 0, due_date: '2026-11-03' };

  const out = { ok: 0, total: 0, intentOk: 0, intentTotal: 0, dateOk: 0, dateTotal: 0, safetyOk: 0, safetyTotal: 0, aiFailed: 0, wrong: [], quiet: [], confidentWrong: 0, confRight: [], confWrong: [] };
  let first = true;
  for (const c of cases) {
    out.total++;
    if (c.safety !== undefined) {
      out.safetyTotal++;
      const got = safetyScan(c.t);
      const ok = got === c.safety;
      if (ok) { out.ok++; out.safetyOk++; } else out.wrong.push({ t: c.t, why: `safety net said ${got}, should be ${c.safety}` });
      console.log(`${ok ? '✓' : '✗'} [safety] ${c.t}`);
      continue;
    }
    if (!first && GAP_MS > 0) await sleep(GAP_MS);
    first = false;
    const falseAlarm = safetyScan(c.t);
    const r = await classifyReply({ cfg, today: TODAY, receivedISO: TODAY, customer, invoices: [invoice], replyText: c.t });
    if (r.failed) { out.aiFailed++; out.wrong.push({ t: c.t, why: 'the AI call failed' }); console.log(`✗ [AI failed] ${c.t}`); continue; }

    out.intentTotal++;
    const intentOk = r.intent === c.intent || (c.alt || []).includes(r.intent);
    if (intentOk) out.intentOk++;
    let dateOk = true;
    if (c.date !== undefined && c.date !== 'any') { out.dateTotal++; dateOk = r.promised_date === c.date; if (dateOk) out.dateOk++; }
    const ok = intentOk && dateOk && !falseAlarm;
    if (ok) { out.ok++; out.confRight.push(r.confidence); } else {
      out.confWrong.push(r.confidence);
      const why = !intentOk ? `read as ${r.intent}, should be ${c.intent}${c.alt ? ' (or ' + c.alt.join(' / ') + ')' : ''}`
        : !dateOk ? `date ${r.promised_date}, should be ${c.date}` : `the safety net fired by mistake (${falseAlarm})`;
      out.wrong.push({ t: c.t, why: `${why}; ${Math.round(r.confidence * 100)}% sure. AI summary: ${r.summary}` });
      if (!intentOk && QUIET.includes(r.intent) && !QUIET.includes(c.intent) && r.confidence >= cfg.minConfidence) out.quiet.push({ t: c.t, got: r.intent });
      if (r.confidence >= cfg.minConfidence) out.confidentWrong++;
    }
    console.log(`${ok ? '✓' : '✗'} ${r.intent.padEnd(20)} ${String(Math.round(r.confidence * 100)).padStart(3)}%  ${c.t}`);
  }

  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
  const avg = a => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 100) + '%' : 'n/a');
  console.log('\n===== RESULT =====');
  console.log(`Overall right:        ${out.ok} of ${out.total} (${pct(out.ok, out.total)})`);
  console.log(`Intent right (AI):    ${out.intentOk} of ${out.intentTotal} (${pct(out.intentOk, out.intentTotal)})`);
  console.log(`Dates right (AI):     ${out.dateOk} of ${out.dateTotal} (${pct(out.dateOk, out.dateTotal)})`);
  console.log(`Safety net right:     ${out.safetyOk} of ${out.safetyTotal}`);
  console.log(`AI calls that failed: ${out.aiFailed}`);
  console.log(`Average sureness:     ${avg(out.confRight)} when right, ${avg(out.confWrong)} when wrong`);
  console.log(`Wrong but "sure" (>= ${Math.round(cfg.minConfidence * 100)}%): ${out.confidentWrong}`);
  console.log(`QUIET mistakes (the owner would not be alerted): ${out.quiet.length}`);
  out.quiet.forEach(q => console.log(`   - "${q.t}" was read as ${q.got}`));
  if (out.wrong.length) { console.log('\nEverything that was wrong:'); out.wrong.forEach(w => console.log(` ✗ "${w.t}"\n     ${w.why}`)); }
  return out.quiet.length ? 1 : 0;
}

module.exports = { CASES, main };
if (require.main === module) main().then(c => process.exit(c)).catch(e => { console.error(e.message); process.exit(1); });
