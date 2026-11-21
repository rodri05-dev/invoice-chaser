-- =====================================================================
-- IC3 part 2: dispute tasks.
-- Supabase -> SQL Editor -> New query -> paste ALL of this -> Run.
-- Safe to run twice ("if not exists" / "drop ... if exists").
-- =====================================================================
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  type text not null default 'dispute',
  category text,                               -- the dispute reason, e.g. missing_po
  assignee_email text,                         -- who should fix it (you, unless a routing rule says otherwise)
  status text not null default 'open'
    check (status in ('open','waiting_on_customer','credit_note_needed','resolved','cancelled')),
  note text,
  due_date date,
  last_alert_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists tasks_status_idx on tasks (status, created_at);
create index if not exists tasks_invoice_idx on tasks (invoice_id);
-- only ONE open task per invoice and type
create unique index if not exists tasks_one_open_per_invoice on tasks (invoice_id, type)
  where status in ('open','waiting_on_customer','credit_note_needed');

-- optional: send a dispute reason to someone other than you (empty = everything goes to you)
create table if not exists routing_rules (
  category text primary key,
  assignee_email text not null
);

drop trigger if exists tasks_touch on tasks;
create trigger tasks_touch before update on tasks for each row execute function touch_updated_at();

alter table tasks enable row level security;
alter table routing_rules enable row level security;
-- No policies on purpose: only server code using the service_role key can touch this data.
