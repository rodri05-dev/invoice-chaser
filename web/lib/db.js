const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// supabase-js returns { data, error } instead of throwing. This turns an error into a real exception.
function must({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

// PostgREST silently returns at most 1,000 rows per request. This pages through everything.
// `build` must return a FRESH query each call, with a stable .order(), e.g.
//   fetchAll(() => supabase.from('invoices').select('*').order('created_at'))
async function fetchAll(build, pageSize = 1000, maxPages = 40) {
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = must(await build().range(page * pageSize, (page + 1) * pageSize - 1));
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

// The audit trail. Never allowed to break the real work, so failures are only logged.
async function logEvent({ invoiceId = null, customerId = null, type, details = {} }) {
  const { error } = await supabase.from('events').insert({ invoice_id: invoiceId, customer_id: customerId, type, details });
  if (error) console.error('logEvent failed:', error.message);
}

module.exports = { supabase, must, fetchAll, logEvent };