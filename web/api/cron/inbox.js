// Triggered by cron-job.org every 5 minutes: reads new replies in the Gmail inbox.
const { isCronAuthorized } = require('../../lib/auth');
const { withJob } = require('../../lib/lock');
const { pollInbox } = require('../../lib/inbox');

module.exports = async (req, res) => {
  if (!isCronAuthorized(req)) return res.status(401).end();
  try {
    res.status(200).json(await withJob('inbox', 120, () => pollInbox()));
  } catch (e) {
    console.error('inbox failed:', e);
    res.status(500).json({ error: e.message });
  }
};