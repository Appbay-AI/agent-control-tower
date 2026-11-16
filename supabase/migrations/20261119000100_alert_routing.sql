-- Task 5.2: alert routing (R4.3). Who gets each alert email (task 5.1) is set by admins on a screen; no code, no deploy.
-- Like the routing matrix (task 2.3), routes are rows an admin edits. For an event on an agent, the most specific
-- route that covers the event is used:
--   1. routes for that agent; else 2. routes for its department; else 3. the default route.
-- A route sends to any of: every admin, the agent's business owner, its technical owner, and named people (the
-- "designated person" of R4.3 is a named person on the default route). A department or agent route can also keep
-- everyone on the default route ("also the default route"). Inactive people are never sent to.
-- The default route starts as task 5.1 behaved: every admin and the agent's business owner.

create table public.alert_routes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  scope text not null check (scope in ('default', 'department', 'agent')),
  department_id uuid references public.departments (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  -- Which events (task 5.1's names); empty = every event.
  events text[] not null default '{}' check (events <@ array['suspended', 're_quarantined', 'reactivated', 'enforcement_pending',
                                                            'discovered', 'missing_at_source', 'access_without_authority']),
  to_admins boolean not null default false,
  to_business_owner boolean not null default false,
  to_technical_owner boolean not null default false,
  people uuid[] not null default '{}',
  also_default boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint alert_route_target check (
    (scope = 'default' and department_id is null and agent_id is null and events = '{}' and not also_default)
    or (scope = 'department' and department_id is not null and agent_id is null)
    or (scope = 'agent' and agent_id is not null and department_id is null)),
  constraint alert_route_sends check (to_admins or to_business_owner or to_technical_owner or cardinality(people) > 0)
);
create unique index alert_routes_one_default on public.alert_routes (scope) where scope = 'default';
create index alert_routes_department on public.alert_routes (department_id) where scope = 'department';
create index alert_routes_agent on public.alert_routes (agent_id) where scope = 'agent';

create function public.alert_routes_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  new.people := array(select distinct x from unnest(new.people) x order by 1);
  if exists (select 1 from unnest(new.people) x where not exists (select 1 from public.profiles p where p.id = x and p.is_active)) then
    raise exception 'Every named person must be an active user' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.scope = 'default' and not new.is_active then
    raise exception 'The default route cannot be switched off' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger alert_routes_check before insert or update on public.alert_routes
  for each row execute function public.alert_routes_check();
create function public.alert_routes_keep_default() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.scope = 'default' then raise exception 'The default route cannot be deleted' using errcode = 'check_violation'; end if;
  return old;
end $$;
create trigger alert_routes_keep_default before delete on public.alert_routes
  for each row execute function public.alert_routes_keep_default();
create trigger audit_change after insert or update or delete on public.alert_routes
  for each row execute function public.audit_table_change();

alter table public.alert_routes enable row level security;
create policy "alert routes readable" on public.alert_routes for select to authenticated using ((select public.sees_everything()));
create policy "alert routes admin" on public.alert_routes for all to authenticated
  using ((select public.has_role('admin'))) with check ((select public.has_role('admin')));
grant select, insert, update, delete on public.alert_routes to authenticated;

insert into public.alert_routes (name, scope, to_admins, to_business_owner, created_by)
values ('Default', 'default', true, true, null);

-- ---------------------------------------------------------------------------
-- Who gets an event's email, and why (one line per person; the first reason found).
-- ---------------------------------------------------------------------------
create function public.alert_recipients(p_agent uuid, p_event text)
returns table (user_id uuid, because text, route_id uuid, route_name text)
language sql stable security definer set search_path = '' as $$
  with a as (select * from public.agents where id = p_agent),
  covering as (
    select r.*, case r.scope when 'agent' then 1 when 'department' then 2 else 3 end lvl
      from public.alert_routes r, a
     where r.is_active and (cardinality(r.events) = 0 or p_event = any (r.events))
       and (r.scope = 'default' or (r.scope = 'agent' and r.agent_id = a.id) or (r.scope = 'department' and r.department_id = a.department_id))),
  chosen as (
    select * from covering where lvl = (select min(lvl) from covering)
    union
    -- "Also the default route"
    select c.* from covering c where c.scope = 'default'
       and exists (select 1 from covering x where x.lvl = (select min(lvl) from covering) and x.also_default)),
  raw as (
    select u.user_id, 1 ord, 'You are an admin of Agent Control Tower.' because, c.id, c.name
      from chosen c join public.user_roles u on u.role = 'admin' where c.to_admins
    union all
    select a.business_owner_id, 2, format('You are the business owner of %s.', a.name), c.id, c.name
      from chosen c, a where c.to_business_owner and a.business_owner_id is not null
    union all
    select a.technical_owner_id, 3, format('You are the technical owner of %s.', a.name), c.id, c.name
      from chosen c, a where c.to_technical_owner and a.technical_owner_id is not null
    union all
    select x, 4, format('You are named on the alert route "%s".', c.name), c.id, c.name
      from chosen c cross join lateral unnest(c.people) x)
  select distinct on (r.user_id) r.user_id, r.because, r.id, r.name
    from raw r join public.profiles p on p.id = r.user_id
   where p.is_active
   order by r.user_id, r.ord
$$;

-- task 5.1's queueing, now through the routes.
create or replace function public.alert_email(p_agent uuid, p_event text, p_headline text, p_facts jsonb, p_key text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  cfg public.push_config;
  ctx jsonb;
  capped boolean := false;
  n integer;
begin
  select * into cfg from public.push_config;
  if not found then return 0; end if;
  ctx := public.agent_alert_context(p_agent);
  if ctx is null then return 0; end if;
  if cfg.alert_email_mode = 'test_inbox' then
    capped := (select count(*) from public.email_outbox
                where kind = 'alert' and created_at >= date_trunc('day', now()) and coalesce(result, '') not like 'Not sent: test site%') >= 20;
  end if;

  insert into public.email_outbox (user_id, kind, agent_id, event, details, dedupe_key, is_test, sent_at, result)
  select r.user_id, 'alert', p_agent, p_event,
         ctx || jsonb_build_object('event', p_event, 'headline', left(p_headline, 300), 'facts', coalesce(p_facts, '[]'),
                                   'at', now(), 'because', r.because, 'route', r.route_name),
         p_key, cfg.alert_email_mode = 'test_inbox',
         case when capped then now() end,
         case when capped then 'Not sent: test site daily limit for alert emails (20) reached' end
    from public.alert_recipients(p_agent, p_event) r
  on conflict (dedupe_key, user_id) where dedupe_key is not null do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- "Test an alert" on the Alert routing page: who would get it, and through which route. Admins, executives, auditors.
create function public.preview_alert_route(p_agent uuid, p_event text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.sees_everything() then
    raise exception 'Only admins, executives and auditors can see alert routing' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', p.full_name, 'job_title', p.job_title, 'because', r.because, 'route', r.route_name)
                     order by p.full_name)
      from public.alert_recipients(p_agent, p_event) r join public.profiles p on p.id = r.user_id), '[]');
end $$;

revoke execute on function public.alert_recipients(uuid, text), public.alert_routes_check(), public.alert_routes_keep_default()
  from public, anon, authenticated;
revoke execute on function public.preview_alert_route(uuid, text) from public, anon;
grant execute on function public.preview_alert_route(uuid, text) to authenticated;
