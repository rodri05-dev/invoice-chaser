// node scripts/check-models.js
// Checks that the AI models your system uses still exist and still answer in JSON mode.
// Run it before each deploy and about once a month. It costs a few hundred tokens in total.
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch (e) { /* dotenv not installed: use real environment variables */ }

const BASE = 'https://api.groq.com/openai/v1';
const NOT_CHAT = /whisper|orpheus|tts|guard|safeguard|embed/i;

// The main model first, then the fallbacks (MODEL_FALLBACKS is a comma-separated list).
function modelsToCheck(env = process.env) {
  const main = (env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b').trim();
  const fallbacks = (env.MODEL_FALLBACKS || 'openai/gpt-oss-20b').split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([main, ...fallbacks])];
}

async function listModels({ fetchImpl = fetch, key }) {
  const res = await fetchImpl(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Groq answered ${res.status} when listing models`);
  const data = await res.json();
  return (data.data || []).map(m => m.id);
}

async function testModel({ fetchImpl = fetch, key, model }) {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 400,
        messages: [{ role: 'system', content: 'Return ONE JSON object and nothing else.' }, { role: 'user', content: 'Return {"ok": true}' }],
        response_format: { type: 'json_object' },
        ...(/gpt-oss/i.test(model) ? { reasoning_effort: 'low' } : {})
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return { model, ok: false, error: `${res.status} ${(await res.text()).replace(/\s+/g, ' ').slice(0, 160)}` };
    const data = await res.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let parsed = null; try { parsed = JSON.parse(text); } catch (e) { /* not JSON */ }
    if (!parsed || typeof parsed !== 'object') return { model, ok: false, error: `it answered, but not in JSON: ${String(text).slice(0, 80)}` };
    return { model, ok: true, tokens: (data.usage && data.usage.total_tokens) || null, ms: Date.now() - t0 };
  } catch (e) {
    return { model, ok: false, error: e.message };
  }
}

// Returns 0 when the main model works, 1 when it does not.
async function main({ fetchImpl = fetch, env = process.env, log = console.log } = {}) {
  const key = env.GROQ_API_KEY;
  if (!key) { log('✗ GROQ_API_KEY is missing from your .env file'); return 1; }
  const models = modelsToCheck(env);

  let listed = null;
  try { listed = await listModels({ fetchImpl, key }); } catch (e) { log(`(could not read Groq's model list: ${e.message})`); }

  let mainOk = false, anyOk = false;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const role = i === 0 ? 'main' : 'fallback';
    const inList = listed ? (listed.includes(model) ? 'listed by Groq' : "NOT in Groq's list") : 'list unknown';
    const r = await testModel({ fetchImpl, key, model });
    if (r.ok) log(`✓ ${model} (${role}): ${inList}, answers in JSON, ${r.tokens === null ? '?' : r.tokens} tokens, ${(r.ms / 1000).toFixed(1)} s`);
    else log(`✗ ${model} (${role}): ${inList}. ${r.error}`);
    if (i === 0) mainOk = r.ok;
    if (r.ok) anyOk = true;
  }

  if (listed) {
    const chat = listed.filter(id => !NOT_CHAT.test(id));
    log(`\nChat models Groq lists right now: ${chat.join(', ') || '(none)'}`);
  }
  if (mainOk) log('\nAll good: the main model works.');
  else if (anyOk) log('\nThe MAIN model failed but a fallback works. In Vercel, set GROQ_CHAT_MODEL to one of the ✓ models above, then redeploy.');
  else log('\nNo model worked. Check GROQ_API_KEY, then the model names above against the list Groq prints.');
  return mainOk ? 0 : 1;
}

module.exports = { modelsToCheck, listModels, testModel, main };
if (require.main === module) main().then(code => process.exit(code)).catch(e => { console.error(e.message); process.exit(1); });
