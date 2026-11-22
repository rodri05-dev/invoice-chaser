-- =====================================================================
-- S1 part A: the Microsoft mailbox connection.
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run.
-- Safe to run twice ("if not exists" / "drop ... if exists").
-- =====================================================================
create table if not exists mail_accounts (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'graph' unique,          -- one connected mailbox per project
  address text not null,
  tenant_id text,
  refresh_token_encrypted text not null,                  -- encrypted with MAIL_TOKEN_KEY; never readable here
  access_token_encrypted text,
  access_expires_at timestamptz,
  status text not null default 'connected' check (status in ('connected','needs_reconnect')),
  last_ok_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists mail_accounts_touch on mail_accounts;
create trigger mail_accounts_touch before update on mail_accounts for each row execute function touch_updated_at();
alter table mail_accounts enable row level security;
-- No policies on purpose: only server code using the service_role key can touch this data.

-- Used in part B (matching a customer's reply to the email we sent):
alter table outbound_messages add column if not exists conversation_id text;
alter table outbound_messages add column if not exists graph_message_id text;
alter table inbound_messages add column if not exists graph_message_id text;
create index if not exists outbound_conversation_idx on outbound_messages (conversation_id);