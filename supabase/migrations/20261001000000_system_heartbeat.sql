-- Phase 0: a single-row table that proves the app can reach the database.
-- The keep-alive workflow reads it every few days so free projects never pause.

create table if not exists public.system_heartbeat (
  id smallint primary key default 1 check (id = 1),
  checked_at timestamptz not null default now()
);

insert into public.system_heartbeat (id) values (1)
on conflict (id) do nothing;

alter table public.system_heartbeat enable row level security;

-- Anyone holding the publishable key may read the heartbeat; nobody may change it through the API.
create policy "heartbeat is readable"
  on public.system_heartbeat
  for select
  to anon, authenticated
  using (true);

comment on table public.system_heartbeat is 'Phase 0 connectivity check and keep-alive target. Not business data.';
