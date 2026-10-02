const crypto = require('crypto');

const safeEqual = (a, b) => {
  const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
// An unset or tiny secret must never authenticate anybody (undefined === undefined is how
// "forgot to set the env var" turns into "the door is open").
const usable = s => typeof s === 'string' && s.length >= 16;
const bearer = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; };

const isDashboardAuthorized = req => usable(process.env.DASHBOARD_ACCESS_TOKEN) && safeEqual(bearer(req), process.env.DASHBOARD_ACCESS_TOKEN);

const isIngestAuthorized = req =>
  isDashboardAuthorized(req) || (usable(process.env.INGEST_API_KEY) && safeEqual(bearer(req), process.env.INGEST_API_KEY));

// Vercel's own cron sends CRON_SECRET as a bearer token; cron-job.org (or you, in a browser tab)
// uses CRON_CHECK_SECRET as a bearer token or as ?secret=
function isCronAuthorized(req) {
  const b = bearer(req), q = req.query && req.query.secret;
  if (usable(process.env.CRON_SECRET) && safeEqual(b, process.env.CRON_SECRET)) return true;
  const s = process.env.CRON_CHECK_SECRET;
  return usable(s) && (safeEqual(b, s) || safeEqual(q, s));
}

module.exports = { safeEqual, usable, isDashboardAuthorized, isIngestAuthorized, isCronAuthorized };