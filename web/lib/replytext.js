// Turning a raw email into "what the person actually wrote", and spotting mail we must not treat as a reply.
const { normEmail } = require('./util');

function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const QUOTE_START = [
  /^on\s.{3,250}\swrote:?\s*$/i,                 // Gmail, Apple Mail: "On Tue, Sep 29, 2026 at 9:14 AM Jo <jo@x.com> wrote:"
  /^le\s.{3,250}\sa écrit\s?:?\s*$/i,            // French clients
  /^-{2,}\s*(original|forwarded) message\s*-{2,}/i,
  /^_{5,}\s*$/,                                  // Outlook divider
  /^sent from my /i,
  /^get outlook for /i,
  /^--\s*$/                                      // signature delimiter
];

// Keeps the new text and drops the quoted history and signature, so the AI reads only the reply.
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const isMarker = (l, i) => {
    const t = l.trim();
    const wrapped = `${t} ${(lines[i + 1] || '').trim()}`.trim();       // "On ... wrote:" often wraps onto two lines
    if (QUOTE_START.some(re => re.test(t) || re.test(wrapped))) return true;
    return /^from:\s/i.test(t) && lines.slice(i + 1, i + 5).some(x => /^(sent|date|to|subject):/i.test(x.trim()));   // Outlook header block
  };
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('>') || isMarker(lines[i], i)) { cut = i; break; }
  }
  let kept = lines.slice(0, cut).join('\n').trim();
  if (kept.length < 2) {   // they replied underneath the quote ("bottom posting"): keep the unquoted lines
    kept = lines.filter((l, i) => !l.trim().startsWith('>') && !isMarker(l, i)).join('\n').trim();
  }
  return kept.replace(/\n{3,}/g, '\n\n').slice(0, 4000);
}

function isAutoReply({ subject = '', headers = {}, from = '' }) {
  const auto = String(headers.autoSubmitted || '').trim().toLowerCase();
  if (auto && auto !== 'no') return true;
  if (/^(bulk|junk|list|auto_reply)$/i.test(String(headers.precedence || '').trim())) return true;
  if (headers.xAutoreply) return true;
  if (/^(no[-_.]?reply|do[-_.]?not[-_.]?reply)@/i.test(from)) return true;
  return /^(automatic reply|auto[- ]?reply|autoreply|out of office|out-of-office|réponse automatique|abwesenheit)/i.test(String(subject).trim());
}

const isBounce = ({ from = '', subject = '' }) =>
  /^(mailer-daemon|postmaster)@/i.test(from) ||
  /^(undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice)/i.test(String(subject).trim());

const extractEmails = text => [...new Set((String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(e => normEmail(e)).filter(Boolean))];

const cleanSubject = s => String(s || '').replace(/^\s*((re|fw|fwd|tr|aw|sv)\s*:\s*)+/i, '').trim();

module.exports = { htmlToText, stripQuoted, isAutoReply, isBounce, extractEmails, cleanSubject };