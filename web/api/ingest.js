// POST here from Make / Zapier / n8n, a script, or the dashboard.
// Authorization: Bearer <INGEST_API_KEY>
const { isIngestAuthorized } = require('../lib/auth');
const { ingestPayload } = require('../lib/ingest');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!isIngestAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const result = await ingestPayload(req.body || {}, 'api');
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('ingest failed:', e);
    res.status(400).json({ ok: false, error: e.message });
  }
};