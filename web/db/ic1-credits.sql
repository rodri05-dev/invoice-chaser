-- IC1-0: credit notes are kept apart from cash.
-- Run once in Supabase -> SQL Editor. Safe to run twice. For a NEW client database, run it after schema.sql.
alter table invoices
  add column if not exists amount_credited_cents bigint not null default 0 check (amount_credited_cents >= 0);