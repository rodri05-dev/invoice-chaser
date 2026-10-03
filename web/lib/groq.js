const BASE = 'https://api.groq.com/openai/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Model names change a few times a year. Set GROQ_CHAT_MODEL in Vercel instead of editing code.
async function groqChat(messages, { json = false, retries = 2, maxTokens = 1500 } = {}) {
  const model = process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b';
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
      if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      return data.choices[0].message.content || '';
    } catch (e) {
      lastError = e;
      if (attempt === retries) throw e;
      await sleep(600);
    }
  }
  throw lastError;
}

module.exports = { groqChat };