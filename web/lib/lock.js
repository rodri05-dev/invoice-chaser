// Two triggers (Vercel cron + cron-job.org) can overlap. A job lock makes sure only one copy
// of a job runs at a time, so a customer can never get the same reminder twice.
const { supabase } = require('./db');

async function acquire(job, ttlSeconds) {
  await supabase.from('jobs').upsert({ job }, { onConflict: 'job', ignoreDuplicates: true });   // make sure the row exists
  const now = new Date();
  const { data, error } = await supabase.from('jobs')
    .update({ locked_until: new Date(now.getTime() + ttlSeconds * 1000).toISOString() })
    .eq('job', job).lt('locked_until', now.toISOString())      // only succeeds if the previous lock has expired
    .select('job');
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length === 1;
}

const slim = obj => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => ['number', 'string', 'boolean'].includes(typeof v)));

async function release(job, { ok, summary }) {
  await supabase.from('jobs').update({
    locked_until: new Date(0).toISOString(), last_run_at: new Date().toISOString(), last_ok: ok, last_summary: slim(summary)
  }).eq('job', job);
}

async function withJob(job, ttlSeconds, fn) {
  if (!(await acquire(job, ttlSeconds))) return { skipped: 'already_running' };
  try {
    const result = await fn();
    await release(job, { ok: true, summary: result });
    return result;
  } catch (e) {
    await release(job, { ok: false, summary: { error: String(e.message).slice(0, 300) } });
    throw e;
  }
}

module.exports = { withJob };