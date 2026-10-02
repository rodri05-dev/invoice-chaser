// node scripts/check-env.js  — tells you exactly which settings are missing before you deploy.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const need = {
  'SUPABASE_URL': 'Supabase → Settings → API', 'SUPABASE_SERVICE_ROLE_KEY': 'Supabase → Settings → API (service_role)',
  'GROQ_API_KEY': 'console.groq.com → API Keys', 'GMAIL_ADDRESS': 'the mailbox that sends and reads', 'GMAIL_APP_PASSWORD': 'myaccount.google.com/apppasswords',
  'OWNER_EMAIL': 'where alerts and the weekly report go', 'BUSINESS_NAME': 'shown in every email', 'APP_DOMAIN': 'your-app.vercel.app (no https://)',
  'DASHBOARD_ACCESS_TOKEN': 'any random string, 16+ characters', 'INGEST_API_KEY': 'any random string, 16+ characters',
  'ACTION_SECRET': 'any random string, 16+ characters', 'CRON_CHECK_SECRET': 'any random string, 16+ characters'
};
let bad = 0;
for (const [k, hint] of Object.entries(need)) {
  const v = process.env[k];
  const short = /SECRET|TOKEN|KEY/.test(k) && /ACCESS|ACTION|CHECK|INGEST/.test(k) && v && v.length < 16;
  if (!v || short) { bad++; console.log(`✗ ${k} ${short ? 'is shorter than 16 characters' : 'is missing'}  (${hint})`); } else console.log(`✓ ${k}`);
}
console.log(`\nDRY_RUN is ${/^(false|0|no|off)$/i.test(process.env.DRY_RUN || '') ? 'OFF — customers WILL be emailed' : 'ON (safe: nothing is sent to customers)'}`);
if (process.env.TEST_EMAIL_OVERRIDE) console.log(`TEST_EMAIL_OVERRIDE → ${process.env.TEST_EMAIL_OVERRIDE}`);
process.exit(bad ? 1 : 0);