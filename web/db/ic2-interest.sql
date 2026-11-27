-- IC2: a contract interest rate per customer (optional; leave empty to use the UK statutory rate).
-- Run once in Supabase -> SQL Editor. Safe to run twice. For a NEW client database, run it after schema.sql.
alter table customers
  add column if not exists contract_interest_pct numeric check (contract_interest_pct is null or contract_interest_pct >= 0);