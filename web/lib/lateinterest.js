// UK late-payment interest and fixed recovery costs (Late Payment of Commercial Debts (Interest) Act 1998).
// PURE functions: no database, no email. Used only to show YOU an estimate. Nothing here is ever added to an
// invoice or sent to a customer automatically. Rates are never hardcoded: they come from the BASE_RATES_JSON setting.
const { addDays, daysBetween } = require('./dates');
const { balanceCents } = require('./money');

const ADD_ON_PCT = 8;                                         // statutory rate = Bank of England base rate + 8%
const NOT_CLAIMABLE = ['disputed', 'payment_claimed'];        // the money may not be owed: no estimate shown

// Interest starts the day AFTER the due date. The base rate is fixed once per half-year, for the whole life of the debt:
//   interest starts 1 Jan to 30 Jun -> the base rate on 31 Dec of the year before
//   interest starts 1 Jul to 31 Dec -> the base rate on 30 Jun of that year
function referenceDate(dueDate) {
  const start = addDays(dueDate, 1);
  const y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
  return m >= 7 ? `${y}-06-30` : `${y - 1}-12-31`;
}

// Fixed sum per invoice: under £1,000 = £40; £1,000 to £9,999.99 = £70; £10,000 and over = £100. (Business-to-business only.)
function compensationFor(cents) {
  const c = Number(cents) || 0;
  if (c <= 0) return 0;
  if (c < 100000) return 4000;
  if (c < 1000000) return 7000;
  return 10000;
}

// Simple interest, not compound: balance x rate x days / 365.
// contractRatePct = a rate the customer agreed in their contract. It replaces the statutory rate, and then no fixed sum
// is added (a contract remedy replaces the statutory one; have a professional confirm this for each client).
function calcInterest({ balanceCents: bal, dueDate, today, rateTable = {}, contractRatePct = null }) {
  const days = daysBetween(dueDate, today);
  if (!(bal > 0) || days <= 0) return { state: 'not_late', days: Math.max(0, days) };
  const contract = contractRatePct === null || contractRatePct === undefined || contractRatePct === '' ? null : Number(contractRatePct);
  const hasContract = contract !== null && Number.isFinite(contract) && contract >= 0;
  let ratePct, ref = null;
  if (hasContract) ratePct = contract;
  else {
    ref = referenceDate(dueDate);
    const base = rateTable[ref];
    if (base === undefined || base === null || !Number.isFinite(Number(base))) return { state: 'rate_missing', referenceDate: ref, days };
    ratePct = Number(base) + ADD_ON_PCT;
  }
  const interestCents = Math.round((bal * ratePct * days) / (100 * 365));
  const compensationCents = hasContract ? 0 : compensationFor(bal);
  return { state: 'ok', days, ratePct, source: hasContract ? 'contract' : 'statutory', referenceDate: ref, interestCents, compensationCents, totalCents: interestCents + compensationCents };
}

// One invoice. null = the feature is off. Part-paid or credited invoices are NOT calculated: the order in which part
// payments and credits reduce interest and the principal is not settled in law, so a person works those out by hand.
function interestForInvoice(inv, { today, cfg }) {
  if (!cfg || !cfg.interest || cfg.interest.mode === 'off') return null;
  if (inv.currency && String(inv.currency).toUpperCase() !== cfg.business.currency) return { state: 'other_currency' };
  if (NOT_CLAIMABLE.includes(inv.status)) return { state: 'not_claimable' };
  if (Number(inv.amount_paid_cents || 0) > 0 || Number(inv.amount_credited_cents || 0) > 0) {
    return daysBetween(inv.due_date, today) > 0 && balanceCents(inv) > 0 ? { state: 'by_hand' } : { state: 'not_late' };
  }
  return calcInterest({
    balanceCents: balanceCents(inv), dueDate: inv.due_date, today, rateTable: cfg.interest.baseRates,
    contractRatePct: inv.customers ? inv.customers.contract_interest_pct : null
  });
}

// All the invoices you pass in, added up for the weekly report.
function interestRollup(invoices, { today, cfg }) {
  const out = { interestCents: 0, compensationCents: 0, count: 0, byHand: 0, missing: [] };
  for (const inv of invoices) {
    const r = interestForInvoice(inv, { today, cfg });
    if (!r) continue;
    if (r.state === 'ok') { out.interestCents += r.interestCents; out.compensationCents += r.compensationCents; out.count++; }
    else if (r.state === 'by_hand') out.byHand++;
    else if (r.state === 'rate_missing' && !out.missing.includes(r.referenceDate)) out.missing.push(r.referenceDate);
  }
  out.missing.sort();
  return out;
}

module.exports = { ADD_ON_PCT, referenceDate, compensationFor, calcInterest, interestForInvoice, interestRollup };