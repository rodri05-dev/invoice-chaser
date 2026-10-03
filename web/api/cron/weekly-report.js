// Vercel cron fires this on Monday mornings. Open it in a browser to see it:
//   ?secret=...&preview=1   shows the report as a web page without sending anything
//   ?secret=...&force=1     sends it again even if this week's report already went out
const { isCronAuthorized } = require('../../lib/auth');
const { sendWeeklyReport } = require('../../lib/report');

module.exports = async (req, res) => {
  if (!isCronAuthorized(req)) return res.status(401).end();
  const q = req.query || {};
  try {
    const result = await sendWeeklyReport({ force: q.force === '1', preview: q.preview === '1' });
    if (result.preview) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.status(200).send(result.html); }
    res.status(200).json(result);
  } catch (e) {
    console.error('weekly report failed:', e);
    res.status(500).json({ error: e.message });
  }
};