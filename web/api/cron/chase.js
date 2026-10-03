// Triggered by cron-job.org every 15 minutes (and by Vercel's daily cron as a backup).
// Manual:  /api/cron/chase?secret=...&dry=1&force=1  -> preview what WOULD be sent, ignoring the sending window.
const { isCronAuthorized } = require('../../lib/auth');
const { withJob } = require('../../lib/lock');
const { runChase } = require('../../lib/chase');

module.exports = async (req, res) => {
  if (!isCronAuthorized(req)) return res.status(401).end();
  const q = req.query || {};
  try {
    const result = await withJob('chase', 240, () => runChase({ force: q.force === '1', dryRun: q.dry === '1' ? true : undefined }));
    res.status(200).json(result);
  } catch (e) {
    console.error('chase failed:', e);
    res.status(500).json({ error: e.message });
  }
};