// node scripts/test-bankholidays.js
// Tests lib/bankholidays.js with FAKE GOV.UK data. No internet needed.
const assert = require('assert');
const { isUkBankHoliday, parseHolidays, resetBankHolidayMemory } = require('../lib/bankholidays');

const ev = date => ({ title: 'x', date, notes: '', bunting: false });
const SAMPLE = {
  'england-and-wales': { division: 'england-and-wales', events: [ev('2026-04-06'), ev('2026-08-31'), ev('2026-12-25'), ev('2026-12-28')] },
  scotland: { division: 'scotland', events: [ev('2026-06-15'), ev('2026-08-03'), ev('2026-12-25'), ev('2026-12-28')] },
  'northern-ireland': { division: 'northern-ireland', events: [ev('2026-04-06'), ev('2026-08-31'), ev('2026-12-25')] }
};
const okFetch = (calls) => async () => { calls.n++; return { ok: true, status: 200, json: async () => SAMPLE }; };
const badFetch = async () => { throw new Error('network down'); };

let passed = 0; const failures = [];
const test = async (name, fn) => { try { resetBankHolidayMemory(); await fn(); passed++; } catch (e) { failures.push(`✗ ${name}\n    ${e.message.split('\n')[0]}`); } };

(async () => {
  await test('parseHolidays keeps only good dates, per region', async () => {
    const p = parseHolidays({ 'england-and-wales': { events: [ev('2026-12-25'), ev('not a date')] } });
    assert.deepStrictEqual(p['england-and-wales'], ['2026-12-25']);
    assert.deepStrictEqual(p.scotland, []);
  });
  await test('a bank holiday is found, a normal day is not', async () => {
    const calls = { n: 0 };
    assert.strictEqual(await isUkBankHoliday('2026-12-25', 'england-and-wales', { fetchImpl: okFetch(calls) }), true);
    assert.strictEqual(await isUkBankHoliday('2026-12-24', 'england-and-wales', { fetchImpl: okFetch(calls) }), false);
  });
  await test('regions differ (Scotland-only day, England-only day)', async () => {
    const calls = { n: 0 }, o = { fetchImpl: okFetch(calls) };
    assert.strictEqual(await isUkBankHoliday('2026-06-15', 'scotland', o), true);
    assert.strictEqual(await isUkBankHoliday('2026-06-15', 'england-and-wales', o), false);
    assert.strictEqual(await isUkBankHoliday('2026-04-06', 'scotland', o), false);
    assert.strictEqual(await isUkBankHoliday('2026-04-06', 'england-and-wales', o), true);
  });
  await test('an unknown region falls back to England and Wales', async () => {
    assert.strictEqual(await isUkBankHoliday('2026-12-28', 'mars', { fetchImpl: okFetch({ n: 0 }) }), true);
  });
  await test('the list is fetched once, then kept for 12 hours', async () => {
    const calls = { n: 0 }, t0 = 1000000;
    await isUkBankHoliday('2026-12-25', 'scotland', { fetchImpl: okFetch(calls), now: t0 });
    await isUkBankHoliday('2026-12-25', 'scotland', { fetchImpl: okFetch(calls), now: t0 + 60 * 60 * 1000 });
    assert.strictEqual(calls.n, 1);
    await isUkBankHoliday('2026-12-25', 'scotland', { fetchImpl: okFetch(calls), now: t0 + 13 * 60 * 60 * 1000 });
    assert.strictEqual(calls.n, 2);
  });
  await test('if GOV.UK fails later, the old copy is still used', async () => {
    const t0 = 1000000;
    await isUkBankHoliday('2026-12-25', 'scotland', { fetchImpl: okFetch({ n: 0 }), now: t0 });
    assert.strictEqual(await isUkBankHoliday('2026-12-25', 'scotland', { fetchImpl: badFetch, now: t0 + 20 * 60 * 60 * 1000 }), true);
  });
  await test('if GOV.UK fails and there is no copy, the answer is "no" (reminders keep working)', async () => {
    assert.strictEqual(await isUkBankHoliday('2026-12-25', 'england-and-wales', { fetchImpl: badFetch }), false);
  });
  await test('an empty or broken answer is not trusted', async () => {
    const empty = async () => ({ ok: true, status: 200, json: async () => ({}) });
    assert.strictEqual(await isUkBankHoliday('2026-12-25', 'england-and-wales', { fetchImpl: empty }), false);
    const err500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.strictEqual(await isUkBankHoliday('2026-12-25', 'england-and-wales', { fetchImpl: err500 }), false);
  });

  console.log(failures.length ? failures.join('\n') : '');
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
