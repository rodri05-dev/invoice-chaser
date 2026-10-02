// Calendar maths on plain 'YYYY-MM-DD' strings, so a due date never slips a day because the
// server (Vercel) runs in UTC while your business doesn't.
const pad = n => String(n).padStart(2, '0');
const toUTC = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isValidISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// The calendar date it is right now on the wall clock of `tz`.
const todayISO = (tz, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const daysBetween = (fromISO, toISO) => Math.round((toUTC(toISO) - toUTC(fromISO)) / 86400000);
const addDays = (iso, n) => new Date(toUTC(iso) + n * 86400000).toISOString().slice(0, 10);
const weekdayOf = iso => WEEKDAYS[new Date(toUTC(iso)).getUTCDay()];
const endOfMonth = iso => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7), 0)).toISOString().slice(0, 10);
const mondayOf = iso => addDays(iso, -((WEEKDAYS.indexOf(weekdayOf(iso)) + 6) % 7));

function formatDate(iso, locale = 'en-US') {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(toUTC(iso)));
}

// Is `now` inside the sending window (allowed weekdays + hours, on the business's clock)?
function inSendWindow(now, cfg) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: cfg.business.timezone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday').value;
  const hour = Number(parts.find(p => p.type === 'hour').value);
  return cfg.send.days.includes(weekday) && hour >= cfg.send.hourStart && hour < cfg.send.hourEnd;
}

// Whole calendar days between a stored timestamp and "today" on the business's clock.
const daysSinceTs = (ts, today, tz) => daysBetween(todayISO(tz, new Date(ts)), today);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Reads the date formats real spreadsheets contain. Returns 'YYYY-MM-DD' or null.
function parseDateLoose(input, locale = 'en-US') {
  if (!input) return null;
  const s = String(input).trim();
  let y, m, d, mt;
  if ((mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/))) {
    y = +mt[1]; m = +mt[2]; d = +mt[3];
  } else if ((mt = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/))) {
    const a = +mt[1], b = +mt[2];
    y = +mt[3]; if (y < 100) y += 2000;
    if (/^en-US$/i.test(locale)) { m = a; d = b; } else { d = a; m = b; }
    if (m > 12 && d <= 12) [m, d] = [d, m];               // 25/12/2026 can only be day-first
  } else if ((mt = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))) {
    m = MONTHS[mt[1].slice(0, 3).toLowerCase()]; d = +mt[2]; y = +mt[3];
  } else if ((mt = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/))) {
    d = +mt[1]; m = MONTHS[mt[2].slice(0, 3).toLowerCase()]; y = +mt[3];
  } else return null;
  if (!m) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return isValidISODate(iso) ? iso : null;
}

module.exports = { isValidISODate, todayISO, daysBetween, addDays, weekdayOf, endOfMonth, mondayOf, formatDate, inSendWindow, daysSinceTs, parseDateLoose };