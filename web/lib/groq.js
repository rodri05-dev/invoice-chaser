const { recordUsage, checkBudget } = require('./aiusage');

const BASE = 'https://api.groq.com/openai/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The main model first, then the fallbacks. Model names change a few times a year:
// set GROQ_CHAT_MODEL and MODEL_FALLBACKS (a comma-separated list) in Vercel instead of editing code.
function modelList(env = process.env) {
  const main = (env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b').trim();
  const fallbacks = (env.MODEL_FALLBACKS || 'openai/gpt-oss-20b').split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([main, ...fallbacks])];
}

class GroqError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// One model, with the same retry rule as before: 429 and 5xx answers are retried after a short pause.
// A clear refusal (for example "model not found") is NOT retried: it moves on to the next model straight away.
async function callModel(model, messages, { json, retries, maxTokens }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, messages, temperature: 0.1, max_tokens: maxTokens,
          ...(/gpt-oss/i.test(model) ? { reasoning_effort: 'low' } : {}),   // reading a short email needs no deep thinking
          ...(json ? { response_format: { type: 'json_object' } } : {})
        })
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(1000 * (attempt + 1)); continue; }
      if (!res.ok) throw new GroqError(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
      const data = await res.json();
      return { content: data.choices[0].message.content || '', tokens: (data.usage && data.usage.total_tokens) || 0 };
    } catch (e) {
      lastError = e;
      if (e.status && e.status !== 429 && e.status < 500) throw e;   // a clear "no": retrying will not change it
      if (attempt === retries) throw e;
      await sleep(600);
    }
  }
  throw lastError;
}

// feature = what the call is for ('classify' today). It is only used for the usage log.
async function groqChat(messages, { json = false, retries = 2, maxTokens = 1500, feature = 'classify' } = {}) {
  const models = modelList();
  const problems = [];
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const r = await callModel(model, messages, { json, retries, maxTokens });
      await recordUsage({ feature, model, totalTokens: r.tokens, ok: true });
      await checkBudget();                                            // never throws
      return r.content;
    } catch (e) {
      await recordUsage({ feature, model, totalTokens: 0, ok: false });
      problems.push(`${model}: ${String(e.message).slice(0, 160)}`);
      if (e.status === 401 || e.status === 403) throw e;            // a wrong key: another model will not help
      if (i < models.length - 1) console.warn(`Groq model ${model} failed, trying ${models[i + 1]}:`, e.message);
    }
  }
  throw new Error(`Every AI model failed. ${problems.join(' | ')}`);
}

module.exports = { groqChat, modelList };
