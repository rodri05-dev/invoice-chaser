// WHAT TO DO about a reply. Pure code, no AI, no database: it takes the AI's reading plus the facts
// and returns a plan. Because the AI can only describe a reply, a malicious or confused email can never
// do more than this table allows: pause chasing for a bounded time, or ask YOU to look.
const { daysBetween } = require('./dates');
const { formatMoney, balanceCents } = require('./money');

const STATE_CHANGING = ['promise_to_pay', 'already_paid', 'extension_request', 'payment_plan_request', 'cannot_pay', 'dispute'];

function decide({ cls, safety, customer, targets, allActive = [], senderKnown, cfg, today, nowISO }) {
  const plus = days => new Date(Date.parse(nowISO) + days * 86400000).toISOString();
  const nums = targets.map(t => t.invoice_number).join(', ');
  const money = formatMoney(targets.reduce((s, t) => s + balanceCents(t), 0), cfg.business.currency, cfg.business.locale);
  const who = customer.name;
  const out = { label: 'noted', patches: [], customerPatch: null, ack: null, alert: null };

  const patch = (inv, p, type, details = {}) => out.patches.push({ invoiceId: inv.id, patch: p, event: { type, details } });
  const patchAll = (p, type, details) => targets.forEach(t => patch(t, typeof p === 'function' ? p(t) : p, type, details));
  const alert = (level, key, headline, actions = []) => { out.alert = { level, key, headline, actions }; };
  const act = (label, action, extra = {}) => ({ label, action, ...extra });
  const hold = (days, note) => ({ status: 'on_hold', paused_until: days ? plus(days) : null, status_note: note });
  const holdEverything = note => {
    out.customerPatch = { do_not_contact: true };
    allActive.filter(i => i.status === 'open' || i.status === 'promised').forEach(i => patch(i, hold(0, note), 'held_all', { note }));
  };

  // ---- guard rails first ----
  if (!targets.length) {
    out.label = 'no_open_invoices';
    alert('info', 'no_open', `${who} replied, but they have no open invoices`);
    return out;
  }
  if (!senderKnown) {                       // someone we don't know is talking about these invoices: change nothing
    out.label = 'unverified_sender';
    alert('action', 'unverified', `A reply about ${nums} came from an address we don't recognise — nothing was changed`);
    return out;
  }
  if (safety === 'legal' || safety === 'bankruptcy' || cls.intent === 'legal_or_hostile') {
    out.label = 'stopped_legal';
    holdEverything(safety === 'bankruptcy' ? 'Customer mentioned bankruptcy' : 'Legal or hostile reply');
    alert('urgent', 'legal', `${who} ${safety === 'bankruptcy' ? 'mentioned bankruptcy' : 'mentioned legal action or was hostile'} — all automatic contact with them has stopped`, [act('Allow contact again', 'allow_contact')]);
    return out;
  }
  if (safety === 'stop' || cls.intent === 'stop_request') {
    out.label = 'stopped_by_request';
    holdEverything('Customer asked us to stop contacting them');
    alert('action', 'stop', `${who} asked us to stop contacting them — automatic contact has stopped`, [act('Allow contact again', 'allow_contact')]);
    return out;
  }
  if (cls.sentiment === 'hostile') {
    out.label = 'hostile';
    patchAll(hold(7, 'Hostile reply — owner review'), 'hostile');
    alert('urgent', 'hostile', `${who} sounds angry about ${nums} — chasing is paused for 7 days`, [act('Resume chasing', 'resume')]);
    return out;
  }
  if (STATE_CHANGING.includes(cls.intent) && cls.confidence < cfg.minConfidence) {
    out.label = 'low_confidence';
    patchAll(hold(3, 'Waiting for the owner to read a reply'), 'low_confidence');
    alert('action', 'low_conf', `Couldn't tell what ${who} meant about ${nums} — please read it (chasing paused 3 days)`, [act('Resume chasing', 'resume')]);
    return out;
  }

  // ---- the intents ----
  switch (cls.intent) {
    case 'dispute':
      out.label = 'disputed';
      patchAll({ status: 'disputed', paused_until: null, status_note: cls.dispute_reason || 'Customer disputes this invoice' }, 'disputed', { reason: cls.dispute_reason });
      alert('urgent', 'dispute', `${who} disputes ${nums} (${money})`, [act('Resume chasing', 'resume'), act('Mark paid', 'mark_paid'), act('Void invoice', 'void')]);
      break;

    case 'already_paid': {
      out.label = 'payment_claimed';
      const note = `Customer says paid${cls.paid_date ? ` on ${cls.paid_date}` : ''}${cls.payment_method ? ` by ${cls.payment_method}` : ''}${cls.payment_reference ? ` (ref ${cls.payment_reference})` : ''}`;
      patchAll({ status: 'payment_claimed', paused_until: null, status_note: note }, 'payment_claimed', { paid_date: cls.paid_date, method: cls.payment_method });
      if (cfg.autoAck) out.ack = { kind: 'paid_ack' };
      alert('action', 'claimed', `${who} says they already paid ${nums} (${money}) — please check your bank`, [act('Mark paid — I verified it', 'mark_paid'), act('Not received — resume chasing', 'resume')]);
      break;
    }

    case 'promise_to_pay': {
      const d = cls.promised_date;
      const away = d ? daysBetween(today, d) : null;
      const usable = d && away >= 0 && away <= cfg.maxPromiseDays;
      const repeats = Math.max(0, ...targets.map(t => t.promised_count || 0));
      if (!usable) {
        out.label = 'promise_no_date';
        patchAll(hold(5, 'Customer says they will pay but gave no usable date'), 'promise_no_date');
        alert('action', 'promise_no_date', `${who} says they'll pay ${nums}, but gave no date we can use — chasing paused 5 days`, [act('Resume chasing now', 'resume')]);
      } else if (repeats >= cfg.maxPromises) {
        out.label = 'promise_repeat';
        patchAll(hold(cfg.decisionHoldDays, `Promised again for ${d} after ${repeats} earlier promise(s)`), 'promise_repeat', { date: d });
        alert('action', 'promise_repeat', `${who} promised ${nums} again (${d}) — that's promise #${repeats + 1}. Time for a call?`, [act(`Accept ${d}`, 'set_promise', { params: { date: d } }), act('Resume chasing', 'resume')]);
      } else {
        out.label = 'promise_recorded';
        patchAll(t => ({ status: 'promised', promised_date: d, promised_count: (t.promised_count || 0) + 1, paused_until: null, broken_promise_at: null, status_note: `Promised to pay by ${d}` }), 'promise_recorded', { date: d, partial_amount: cls.partial_amount });
        if (cfg.autoAck) out.ack = { kind: 'promise_ack', date: d };
        if (cfg.notifyOnPromise || cls.partial_amount) alert('info', 'promise', `${who} promised to pay ${cls.partial_amount ? `${formatMoney(Math.round(cls.partial_amount * 100), cfg.business.currency, cfg.business.locale)} of ` : ''}${nums} by ${d}`, [act('Mark paid', 'mark_paid')]);
      }
      break;
    }

    case 'extension_request': {
      const d = cls.promised_date;
      const away = d ? daysBetween(today, d) : null;
      const ok = d && away > 0 && away <= cfg.maxPromiseDays;
      out.label = 'extension_requested';
      patchAll(hold(cfg.decisionHoldDays, ok ? `Asked for more time, until ${d}` : 'Asked for more time'), 'extension_requested', { date: d });
      alert('action', 'extension', `${who} asks for more time on ${nums} (${money})${ok ? `, until ${d}` : ''}`, [...(ok ? [act(`Approve until ${d}`, 'set_promise', { params: { date: d } })] : []), act('Decline — resume chasing', 'resume')]);
      break;
    }

    case 'payment_plan_request':
    case 'cannot_pay':
      out.label = cls.intent;
      patchAll(hold(cfg.decisionHoldDays, cls.intent === 'cannot_pay' ? 'Customer says they cannot pay right now' : 'Customer asked for a payment plan'), cls.intent);
      alert('action', cls.intent, `${who} ${cls.intent === 'cannot_pay' ? "says they can't pay right now" : 'asks to pay in instalments'} (${nums}, ${money}) — chasing paused ${cfg.decisionHoldDays} days while you decide`, [act('Resume chasing', 'resume'), act('Snooze 30 days', 'snooze', { params: { days: 30 } })]);
      break;

    case 'needs_invoice_copy':
      out.label = 'invoice_copy';
      patchAll(hold(3, 'Asked for an invoice copy'), 'invoice_copy_requested');
      if (cfg.autoAck && targets.every(t => t.invoice_url)) out.ack = { kind: 'invoice_copy' };
      else alert('action', 'copy', `${who} asked for a copy of ${nums}${targets.some(t => !t.invoice_url) ? " — no invoice link is stored, so please send it yourself" : ''}`, [act('Resume chasing', 'resume')]);
      break;

    case 'wrong_contact':
      out.label = 'wrong_contact';
      patchAll(hold(14, 'Wrong contact — waiting for the right billing contact'), 'wrong_contact', { new_email: cls.new_contact_email });
      alert('action', 'wrong_contact', `${who}'s contact says they're not the right person${cls.new_contact_email ? ` and points to ${cls.new_contact_email}` : ''}`,
        [...(cls.new_contact_email ? [act(`Use ${cls.new_contact_email} from now on`, 'set_contact', { params: { email: cls.new_contact_email } })] : []), act('Resume chasing', 'resume')]);
      break;

    case 'acknowledged':
      out.label = 'acknowledged';
      if (cls.sentiment === 'negative') alert('action', 'ack_negative', `${who} replied about ${nums} and sounds unhappy`);
      break;

    default:
      out.label = 'needs_human';
      patchAll(hold(3, 'Waiting for the owner to read a reply'), 'needs_human');
      alert('action', 'other', `${who} replied about ${nums} — it needs a human (chasing paused 3 days)`, [act('Resume chasing', 'resume')]);
  }
  return out;
}

module.exports = { decide };