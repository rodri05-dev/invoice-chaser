// Dispute reasons, and what to collect for each one. Plain code, no AI: the AI only PICKS the reason.
// Everything the owner reads about what to do comes from this fixed list, so it can never contain
// invented advice. Nothing here is ever sent to a customer.
const CATEGORIES = ['missing_po', 'wrong_amount', 'delivery_not_confirmed', 'work_incomplete', 'wrong_quantity', 'missing_paperwork', 'unapproved_extra_work', 'other'];

const INFO = {
  missing_po: {
    label: 'PO number missing',
    collect: [
      'Find the purchase order (PO) number the customer should have quoted: check their order email, the quote or the contract.',
      'If they never gave you one, ask who approves invoices on their side.',
      'Send them the invoice again with the PO number on it, or ask them to confirm in writing that none is needed.'
    ]
  },
  wrong_amount: {
    label: 'Amount disputed',
    collect: [
      'Compare the invoice with the quote, the contract or the order confirmation.',
      'Check the rate, the quantity, any agreed discount and the VAT.',
      'If the invoice is wrong: raise a credit note and a corrected invoice in your accounting software.',
      'If it is right: send the customer the document that shows the agreed price.'
    ]
  },
  delivery_not_confirmed: {
    label: 'Delivery not confirmed',
    collect: [
      'Find the delivery note, proof of delivery or signed receipt.',
      'Check the date, the address and who signed for it.',
      'Send the customer the proof. If you cannot find any, check with the driver or courier before you reply.'
    ]
  },
  work_incomplete: {
    label: 'Work not finished or faulty',
    collect: [
      'Find the job sheet, completion certificate or sign-off for this work.',
      'Look for photos, timesheets or emails that show what was done and when.',
      'If something really is unfinished or faulty, agree a date to put it right and tell the customer.'
    ]
  },
  wrong_quantity: {
    label: 'Quantity disputed',
    collect: [
      'Compare the invoice with the order, the delivery note and any returns.',
      'Work out what was ordered, what was sent and what was received.',
      'If the invoice is wrong: raise a credit note and a corrected invoice in your accounting software.'
    ]
  },
  missing_paperwork: {
    label: 'Paperwork missing',
    collect: [
      'Find out exactly which document they need (for example a contract, timesheet, certificate or VAT invoice).',
      'Send it to them, or tell them when it will arrive.'
    ]
  },
  unapproved_extra_work: {
    label: 'Extra work not approved',
    collect: [
      'Find the written approval for the extra work: an email, a variation order or a signed change sheet.',
      'If there is none, decide whether to ask them to approve it now or to credit the extra.'
    ]
  },
  other: {
    label: 'Dispute, reason unclear',
    collect: [
      'Read their reply and decide what they object to. Phone them if it is still not clear.',
      'Gather the order, the delivery or sign-off papers and the invoice for this job.'
    ]
  }
};

const categoryOf = c => (CATEGORIES.includes(c) ? c : 'other');
const labelOf = c => INFO[categoryOf(c)].label;

// Lines added to the owner's alert email (after the customer's own words).
function disputeLines(category) {
  const i = INFO[categoryOf(category)];
  return ['', `Reason (the AI's reading, please check it): ${i.label}`, 'What to collect before you reply:', ...i.collect.map((t, n) => `  ${n + 1}. ${t}`)];
}

module.exports = { CATEGORIES, INFO, categoryOf, labelOf, disputeLines };
