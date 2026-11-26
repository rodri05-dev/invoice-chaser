// Is a date a UK bank holiday? Uses the free, official GOV.UK list (no key needed).
// It never touches your database. The list is kept in memory for 12 hours.
// If GOV.UK cannot be reached, the last good copy is used. If there is no copy at all,
// the answer is "no" so a GOV.UK outage can never stop your reminders.
const URL = 'https://www.gov.uk/bank-holidays.json';
const REGIONS = ['england-and-wales', 'scotland', 'northern-ireland'];
const KEEP_MS = 12 * 60 * 60 * 1000;

let memory = { list: null, savedAt: 0 };

// GOV.UK sends { 'england-and-wales': { events: [{ date: '2026-12-25', ... }] }, ... }.
// This turns it into { 'england-and-wales': ['2026-12-25', ...], ... }.
function parseHolidays(json) {
  const out = {};
  for (const region of REGIONS) {
    const events = json && json[region] && Array.isArray(json[region].events) ? json[region].events : [];
    out[region] = events.map(e => String(e.date || '')).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  }
  return out;
}

async function getList({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (memory.list && now - memory.savedAt < KEEP_MS) return memory.list;
  try {
    const res = await fetchImpl(URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`GOV.UK answered ${res.status}`);
    const list = parseHolidays(await res.json());
    if (!REGIONS.some(r => list[r].length)) throw new Error('GOV.UK list came back empty');
    memory = { list, savedAt: now };
    return list;
  } catch (e) {
    console.warn('bank holiday list not refreshed:', e.message);
    return memory.list;            // the old copy, or null if we never had one
  }
}

// iso = 'YYYY-MM-DD' (today on the business's own clock). region = one of REGIONS.
async function isUkBankHoliday(iso, region = 'england-and-wales', opts) {
  const list = await getList(opts);
  const r = REGIONS.includes(region) ? region : 'england-and-wales';
  return !!(list && list[r].includes(iso));
}

function resetBankHolidayMemory() { memory = { list: null, savedAt: 0 }; }   // used by the tests

module.exports = { isUkBankHoliday, parseHolidays, REGIONS, resetBankHolidayMemory };
