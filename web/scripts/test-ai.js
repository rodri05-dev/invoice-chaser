// node scripts/test-ai.js  — checks the AI fallback and the usage log with a FAKE Groq, database and email.
// No internet, no tokens used.
const assert = require('assert');

// ----- fakes -----
const state = { inserts: [], usageRows: [], failInsert: false, failFetchAll: false, alerts: [] };
const fakeDb = {
  supabase: { from: () => ({ insert: async row => (state.failInsert ? { error: { message: 'relation "ai_usage" does not exist' } } : (state.inserts.push(row), { error: null })),
    select: () => ({ gte: () => ({ order: () => ({ order: () => ({}) }) }) }) }) },
  fetchAll: async () => { if (state.failFetchAll) throw new Error('no table'); return state.usageRows; },
  must: x => x, logEvent: async () => {}
};
const fakeNotify = { alertOwner: async a => { state.alerts.push(a); return { sent: true }; } };
const plant = (file, exports) => { const p = require.resolve(file); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
plant('../lib/db', fakeDb);
plant('../lib/notify', fakeNotify);

const { groqChat, modelList } = require('../lib/groq');
const { summarise } = require('../lib/aiusage');

let calls = [], script = [];
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const good = (content, tokens) => reply(200, { choices: [{ message: { content } }], usage: { total_tokens: tokens } });
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body); calls.push(body);
  const next = script.shift();
  if (!next) throw new Error('the test ran out of fake answers');
  if (next instanceof Error) throw next;
  return next;
};
const realSetTimeout = global.setTimeout;
global.setTimeout = fn => { fn(); return 0; };       // no real waiting between retries

process.env.GROQ_API_KEY = 'test-key';
delete process.env.GROQ_CHAT_MODEL; delete process.env.MODEL_FALLBACKS; delete process.env.AI_DAILY_TOKEN_LIMIT; delete process.env.AI_ALERT_PERCENT;

const reset = () => { calls = []; script = []; state.inserts = []; state.usageRows = []; state.failInsert = false; state.failFetchAll = false; state.alerts = []; };
let passed = 0; const failures = [];
const test = async (name, fn) => { reset(); try { await fn(); passed++; } catch (e) { failures.push(`✗ ${name}\n    ${e.message.split('\n')[0]}`); } };
const MSGS = [{ role: 'user', content: 'hi' }];

(async () => {
  await test('model list: defaults, overrides, no duplicates', async () => {
    assert.deepStrictEqual(modelList({}), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
    assert.deepStrictEqual(modelList({ GROQ_CHAT_MODEL: 'a/b', MODEL_FALLBACKS: 'c/d, a/b ,e/f' }), ['a/b', 'c/d', 'e/f']);
  });
  await test('summarise: counts the main model only, and the fallback calls and failures', async () => {
    const s = summarise([
      { model: 'm', total_tokens: 1000, ok: true }, { model: 'm', total_tokens: 500, ok: true },
      { model: 'f', total_tokens: 300, ok: true }, { model: 'm', total_tokens: 0, ok: false }
    ], { main: 'm', limit: 2000, alertPercent: 80 });
    assert.deepStrictEqual([s.tokens, s.percent, s.calls, s.fallbackCalls, s.failures], [1500, 75, 3, 1, 1]);
  });
  await test('main model works: answer returned, one usage row written', async () => {
    script = [good('{"a":1}', 61)];
    assert.strictEqual(await groqChat(MSGS, { json: true }), '{"a":1}');
    assert.deepStrictEqual(state.inserts, [{ feature: 'classify', model: 'openai/gpt-oss-120b', total_tokens: 61, ok: true }]);
    assert.strictEqual(calls.length, 1);
  });
  await test('JSON mode always; reasoning_effort only for gpt-oss models', async () => {
    process.env.GROQ_CHAT_MODEL = 'qwen/qwen3.8-27b';
    try { script = [good('{}', 5)]; await groqChat(MSGS, { json: true }); } finally { delete process.env.GROQ_CHAT_MODEL; }
    assert.deepStrictEqual(calls[0].response_format, { type: 'json_object' }); assert.strictEqual(calls[0].reasoning_effort, undefined);
    reset(); script = [good('{}', 5)]; await groqChat(MSGS, { json: true });
    assert.strictEqual(calls[0].reasoning_effort, 'low');
  });
  await test('main model retired (404): fallback answers, no pointless retries', async () => {
    script = [reply(404, 'model_not_found'), good('from fallback', 40)];
    assert.strictEqual(await groqChat(MSGS), 'from fallback');
    assert.deepStrictEqual(calls.map(c => c.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
    assert.deepStrictEqual(state.inserts.map(r => [r.model, r.ok, r.total_tokens]), [['openai/gpt-oss-120b', false, 0], ['openai/gpt-oss-20b', true, 40]]);
  });
  await test('main model rate-limited (429): retried 3 times, then the fallback answers', async () => {
    script = [reply(429, 'slow'), reply(429, 'slow'), reply(429, 'slow'), good('ok2', 10)];
    assert.strictEqual(await groqChat(MSGS), 'ok2');
    assert.deepStrictEqual(calls.map(c => c.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-120b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  });
  await test('a network blip is retried on the same model', async () => {
    script = [new Error('fetch failed'), good('back', 7)];
    assert.strictEqual(await groqChat(MSGS), 'back');
    assert.deepStrictEqual(calls.map(c => c.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-120b']);
  });
  await test('a wrong key (401) stops at once: no fallback is tried', async () => {
    script = [reply(401, 'bad key')];
    await assert.rejects(() => groqChat(MSGS), /401/);
    assert.strictEqual(calls.length, 1);
  });
  await test('every model failing gives one clear error naming each model', async () => {
    script = [reply(404, 'gone'), reply(404, 'gone too')];
    await assert.rejects(() => groqChat(MSGS), e => /Every AI model failed/.test(e.message) && e.message.includes('gpt-oss-120b') && e.message.includes('gpt-oss-20b'));
  });
  await test('the usage log records the feature name it is given', async () => {
    script = [good('x', 3)]; await groqChat(MSGS, { feature: 'triage' });
    assert.strictEqual(state.inserts[0].feature, 'triage');
  });
  await test('budget alert: sent at 80% or more, once, with the right key', async () => {
    state.usageRows = [{ model: 'openai/gpt-oss-120b', total_tokens: 170000, ok: true }];
    script = [good('x', 3)]; await groqChat(MSGS);
    assert.strictEqual(state.alerts.length, 1);
    assert.deepStrictEqual([state.alerts[0].key, state.alerts[0].dedupeHours, state.alerts[0].level], ['ai_budget', 24, 'info']);
    assert(/85%/.test(state.alerts[0].headline));
  });
  await test('budget alert: not sent below the limit, and the limit can be changed', async () => {
    state.usageRows = [{ model: 'openai/gpt-oss-120b', total_tokens: 50000, ok: true }];
    script = [good('x', 3)]; await groqChat(MSGS);
    assert.strictEqual(state.alerts.length, 0);
    process.env.AI_DAILY_TOKEN_LIMIT = '60000';
    try { reset(); state.usageRows = [{ model: 'openai/gpt-oss-120b', total_tokens: 50000, ok: true }]; script = [good('x', 3)]; await groqChat(MSGS); } finally { delete process.env.AI_DAILY_TOKEN_LIMIT; }
    assert.strictEqual(state.alerts.length, 1);
  });
  await test('a missing ai_usage table never breaks the AI call', async () => {
    state.failInsert = true; state.failFetchAll = true;
    script = [good('still works', 9)];
    assert.strictEqual(await groqChat(MSGS), 'still works');
    assert.strictEqual(state.alerts.length, 0);
  });

  global.setTimeout = realSetTimeout;
  console.log(failures.length ? failures.join('\n') : '');
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
