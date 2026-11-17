-- Task 5.4: an in-app notification alongside every email (R4.5).
-- Every email the Control Tower queues (approval requests 2.7 / 2.10, alert emails 5.1, reactivation emails 5.3) also
-- puts a notification in that person's in-app list, which arrives through Supabase Realtime within about a second. The
-- notification is made whether or not the email itself could be sent (a test address, the daily limit, no email set up).
--
-- Phone alerts for the seven alert events now follow the alert routes too (task 5.2): each alert email also queues a
-- phone alert to the same person. The earlier fixed phone alerts for four of those events (not stopped yet, found on a
-- platform, switched on outside Control Tower, no authority: admins and owners) are retired, so nobody gets two.

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('new', 'escalated', 'second', 'alert', 'reactivation', 'reactivation_second')),
  event text,
  title text not null check (length(title) <= 200),
  body text not null check (length(body) <= 600),
  url text not null check (url like '/%'),
  pii boolean not null default false,
  agent_id uuid references public.agents (id) on delete cascade,
  email_id bigint unique references public.email_outbox (id) on delete set null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user on public.notifications (user_id, created_at desc);
create index notifications_unread on public.notifications (user_id) where read_at is null;
alter table public.notifications enable row level security;
create policy "own notifications" on public.notifications for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
-- Realtime (the in-app list updates live; RLS decides who receives which row).
alter table public.notifications replica identity full;
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_catalog.pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- Marks the signed-in person's notifications read: the ones given, or all of them.
create function public.mark_notifications_read(p_ids bigint[] default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.mark_notifications_read(bigint[]) from public, anon;
grant execute on function public.mark_notifications_read(bigint[]) to authenticated;

alter table public.push_outbox drop constraint push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check
  check (kind in ('action_request', 'test', 'agent_discovered', 'suspension', 'enforcement', 'incident', 'reactivation',
                  'reconciliation', 'data_authority', 'incident_closure', 'review_required', 'alert'));

-- What the notification (and, for alerts, the phone alert) says.
create function public.email_notification() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t text;
  b text;
  u text;
  pii boolean := false;
  agent uuid := new.agent_id;
  r public.action_requests;
  x public.agent_reactivations;
  a public.agents;
  label constant jsonb := '{"suspended":"Suspended","reactivated":"Switched back on","re_quarantined":"Blocked again",
    "enforcement_pending":"Not stopped yet","discovered":"Found, not registered","missing_at_source":"Missing from its platform",
    "access_without_authority":"Access without authority"}';
begin
  if new.kind in ('new', 'escalated', 'second') then
    select * into r from public.action_requests where id = new.request_id;
    if not found then return null; end if;
    agent := r.agent_id;
    t := case new.kind when 'second' then 'Second approval needed · ' when 'escalated' then 'Escalated to you · ' else 'Approval needed · ' end || r.request_code;
    b := public.request_alert_body(r);
    u := '/approvals/requests/' || r.id;
  elsif new.kind = 'alert' then
    select * into a from public.agents where id = new.agent_id;
    pii := coalesce((new.details ->> 'pii')::boolean, false)
           or exists (select 1 from jsonb_array_elements(coalesce(new.details -> 'people', '[]')) p where p -> 'missing' ? 'personal');
    t := format('%s%s · %s', case when pii then 'Personal data · ' else '' end, coalesce(label ->> new.event, 'Alert'), a.agent_code);
    b := coalesce(new.details ->> 'headline', a.name);
    u := '/agents/' || a.id;
  elsif new.kind in ('reactivation', 'reactivation_second') then
    select * into x from public.agent_reactivations where id = new.reactivation_id;
    select * into a from public.agents where id = x.agent_id;
    agent := a.id;
    t := case new.kind when 'reactivation_second' then 'Second approval needed · ' else 'Switch back on? · ' end || a.agent_code;
    b := format('%s asks to switch %s back on: %s', coalesce((select full_name from public.profiles where id = x.requested_by), 'Someone'), a.name, x.reason);
    u := '/approvals/reactivations/' || x.id;
  else
    return null;
  end if;

  insert into public.notifications (user_id, kind, event, title, body, url, pii, agent_id, email_id)
  values (new.user_id, new.kind, new.event, left(t, 200), left(b, 600), u, pii, agent, new.id)
  on conflict (email_id) do nothing;

  -- Phone alert for the seven alert events, to the same person (the routes of task 5.2).
  if new.kind = 'alert' then
    insert into public.push_outbox (user_id, kind, title, body, url)
    values (new.user_id, 'alert', left(t, 200), left(b, 300), u);
  end if;
  return null;
end $$;
create trigger email_notification after insert on public.email_outbox
  for each row execute function public.email_notification();

-- The earlier fixed phone alerts for four alert events are replaced by the routed ones above.
create function public.push_outbox_retired_kinds() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind in ('enforcement', 'agent_discovered', 'reconciliation', 'data_authority') then return null; end if;
  -- The asker's "Switched back on" (task 4.6) when the routed alert just told them the same thing.
  if new.kind = 'reactivation' and new.title like 'Switched back on · %'
     and exists (select 1 from public.push_outbox o where o.user_id = new.user_id and o.kind = 'alert' and o.title = new.title
                  and o.created_at = now()) then
    return null;
  end if;
  return new;
end $$;
create trigger push_outbox_retired_kinds before insert on public.push_outbox
  for each row execute function public.push_outbox_retired_kinds();

revoke execute on function public.email_notification(), public.push_outbox_retired_kinds() from public, anon, authenticated;
