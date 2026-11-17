-- =====================================================================
-- Invoice Chaser: full schema, for a NEW client project.
-- Supabase -> SQL Editor -> New query -> paste the whole file -> Run.
-- Do NOT run this on a project that already has these tables: it would stop with "already exists".
-- (Your own project was built from this same text, plus the ai_usage table at the bottom.)
-- =====================================================================

-- ============ CUSTOMERS (who owes you money) ============
create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,                          -- the person we address the emails to
  email text unique,                          -- billing contact; the code always stores it lowercase
  extra_emails text[] not null default '{}',  -- other addresses we accept replies from
  phone text,                                 -- E.164, e.g. +447123456789 (only used for optional SMS)
  sms_consent boolean not null default false, -- SMS is only ever sent when this is true
  reply_token text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 10),
  do_not_contact boolean not null default false,
  email_bounced boolean not null default false,
  last_contacted_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============ INVOICES ============
create table invoices (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  invoice_number text not null,
  source text not null default 'manual',      -- 'manual' | 'csv' | 'api'
  currency text not null default 'GBP',
  amount_cents bigint not null check (amount_cents >= 0),
  amount_paid_cents bigint not null default 0,
  issue_date date,
  due_date date not null,
  invoice_url text,                           -- pay link or PDF link, shown in reminders
  po_number text,
  description text,
  status text not null default 'open'
    check (status in ('open','promised','payment_claimed','disputed','on_hold','escalated','paid','void')),
  status_note text,
  reminder_count int not null default 0,      -- how many sequence steps have been sent
  last_reminder_at timestamptz,
  promised_date date,
  promised_count int not null default 0,
  broken_promise_at timestamptz,
  paused_until timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, invoice_number)
);
create index invoices_status_idx on invoices (status);
create index invoices_due_idx on invoices (due_date);
create index invoices_customer_idx on invoices (customer_id);

-- ============ OUTBOUND LOG (every reminder, acknowledgement, alert and report) ============
create table outbound_messages (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                         -- 'reminder' | 'ack' | 'owner_alert' | 'report'
  channel text not null default 'email',      -- 'email' | 'sms'
  customer_id uuid references customers(id) on delete set null,
  invoice_ids uuid[] not null default '{}',
  to_address text,
  subject text,
  body_text text,
  step_key text,
  tone text,
  message_id text,
  status text not null default 'sent',        -- 'sent' | 'dry_run' | 'failed'
  error text,
  created_at timestamptz not null default now()
);
create index outbound_customer_idx on outbound_messages (customer_id, created_at desc);
create index outbound_kind_idx on outbound_messages (kind, created_at desc);

-- ============ INBOUND LOG (every reply the AI reads) ============
create table inbound_messages (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'email',
  message_id text unique,                     -- RFC Message-ID (email) or Twilio MessageSid (sms); stops double-processing
  from_address text,
  from_name text,
  subject text,
  body_text text,                             -- the reply with quoted history removed
  received_at timestamptz not null default now(),
  customer_id uuid references customers(id) on delete set null,
  invoice_ids uuid[] not null default '{}',
  match_method text,                          -- token | sender | domain | invoice_number | phone
  kind text not null default 'reply',         -- reply | auto_reply | bounce | unmatched
  intent text,
  confidence numeric,
  ai_result jsonb,
  needs_human boolean not null default false,
  action_taken text,
  created_at timestamptz not null default now()
);
create index inbound_created_idx on inbound_messages (created_at desc);

-- ============ EVENTS (audit trail + feeds the dashboard and weekly report) ============
create table events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index events_created_idx on events (created_at desc);
create index events_invoice_idx on events (invoice_id, created_at desc);

-- ============ JOBS (locks so two runs can't double-send + "last run" health) ============
create table jobs (
  job text primary key,
  locked_until timestamptz not null default 'epoch',
  last_run_at timestamptz,
  last_ok boolean,
  last_summary jsonb
);

-- ============ keep updated_at honest ============
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger customers_touch before update on customers for each row execute function touch_updated_at();
create trigger invoices_touch  before update on invoices  for each row execute function touch_updated_at();

-- ============ lock everything down ============
alter table customers         enable row level security;
alter table invoices          enable row level security;
alter table outbound_messages enable row level security;
alter table inbound_messages  enable row level security;
alter table events            enable row level security;
alter table jobs              enable row level security;
-- No policies on purpose: only server code using the service_role key can touch this data.
-- The public anon key alone can read and write nothing.

-- ============ AI USAGE (tokens used per AI call; feeds the dashboard and the 80% alert) ============
create table if not exists ai_usage (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  feature text not null,
  model text,
  total_tokens int not null default 0,
  ok boolean not null default true
);
create index if not exists ai_usage_created_idx on ai_usage (created_at desc);
alter table ai_usage enable row level security;
