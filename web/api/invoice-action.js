const { isDashboardAuthorized } = require('../lib/auth');
const { performAction, ACTIONS } = require('../lib/actions');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isDashboardAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const { action, invoiceId, customerId, params } = req.body || {};
  if (!ACTIONS.includes(action)) return res.status(400).json({ error: 'unknown action' });
  try {
    await performAction({ action, invoiceId, customerId, params: params || {}, actor: 'owner (dashboard)' });
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};