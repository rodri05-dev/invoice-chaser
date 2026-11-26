// Records how many AI tokens each call uses, and tells you how much of today's free allowance is gone.
// Nothing in here is allowed to break the real work: every failure is only logged.

// Groq's free allowance counts per model. Set AI_DAILY_TOKEN_LIMIT in Vercel if Groq changes it.
const dailyLimit = () => Number(process.env.AI_DAILY_TOKEN_LIMIT) || 200000;
const alertPercent = () => Number(process.env.AI_ALERT_PERCENT) || 80;

// "Today" starts at midnight UTC. This is an estimate: Groq's own counter may reset at another time.
const utcMidnightISO = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

async function recordUsage({ feature, model, totalTokens = 0, ok = true }) {
  try {
    const { supabase } = require('./db');      // loaded when needed, so tests that never call the AI need no database settings
    const { error } = await supabase.from('ai_usage').insert({ feature, model, total_tokens: totalTokens, ok });
    if (error) console.error('ai_usage insert failed:', error.message);
  } catch (e) {
    console.error('ai_usage failed:', e.message);
  }
}

// Pure: rows in, numbers out. `main` is the main model, whose allowance the percentage is about.
function summarise(rows, { main, limit, alertPercent: alertAt }) {
  const mainTokens = rows.filter(r => r.model === main).reduce((s, r) => s + (Number(r.total_tokens) || 0), 0);
  const good = rows.filter(r => r.ok);
  return {
    model: main, tokens: mainTokens, limit, alertPercent: alertAt,
    percent: Math.min(999, Math.round((mainTokens / limit) * 100)),
    calls: good.length,
    fallbackCalls: good.filter(r => r.model !== main).length,
    failures: rows.length - good.length
  };
}

async function usageSummary({ now = new Date() } = {}) {
  try {
    const { supabase, fetchAll } = require('./db');
    const { modelList } = require('./groq');
    const rows = await fetchAll(() =>
      supabase.from('ai_usage').select('model, total_tokens, ok').gte('created_at', utcMidnightISO(now)).order('created_at').order('id'));
    return summarise(rows, { main: modelList()[0], limit: dailyLimit(), alertPercent: alertPercent() });
  } catch (e) {
    console.error('usageSummary failed:', e.message);
    return null;
  }
}

// Called after every successful AI call. One email a day, at most.
async function checkBudget() {
  try {
    const s = await usageSummary();
    if (!s || s.percent < s.alertPercent) return;
    const { alertOwner } = require('./notify');
    await alertOwner({
      level: 'info', key: 'ai_budget', dedupeHours: 24,
      headline: `The AI has used ${s.percent}% of today's free allowance`,
      lines: [
        `About ${s.tokens.toLocaleString('en-GB')} of ${s.limit.toLocaleString('en-GB')} tokens used today on ${s.model} (an estimate).`,
        'If the allowance runs out, the AI moves to a fallback model, which has its own allowance. If every model is used up, replies are not read by the AI: each one still reaches you as an alert to read yourself. Nothing is lost.'
      ]
    });
  } catch (e) {
    console.error('AI budget check failed:', e.message);
  }
}

module.exports = { recordUsage, usageSummary, summarise, checkBudget, utcMidnightISO };
