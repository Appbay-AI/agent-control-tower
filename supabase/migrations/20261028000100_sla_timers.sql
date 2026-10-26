-- Phase 2, task 2.9: time limits (SLA timers). A waiting request must be decided within a time limit. When the limit
-- passes, the request is either escalated once to a named next approver (if its routing rule says so), or, by default,
-- it expires: the agent is told no (fail closed). Everything the timer does is in the audit trail as "system".
--
--   Limit:   the routing rule's own limit if it has one, else the default for the request's urgency (sla_settings,
--            editable by admins on the Routing screen). Defaults: critical 30 min, high 2 h, normal 8 h, low 24 h.
--   Overdue: rule says "escalate to X" and the timer has not escalated it yet, and X can decide it → X gets it with a
--            fresh limit (alert and email as for any escalation). Otherwise → status "expired", decided by "timeout".
--   Clock:   pg_cron runs sla_sweep() every minute, so a request goes at most about a minute past its limit.
-- Requests already waiting when this was released have no limit (due_at stays empty), so nothing expires by surprise.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create table public.sla_settings (
  urgency public.action_urgency primary key,
  minutes integer not null check (minutes between 1 and 43200), -- up to 30 days
  updated_at timestamptz not null default now()
);
insert into public.sla_settings (urgency, minutes) values ('critical', 30), ('high', 120), ('normal', 480), ('low', 1440);
alter table public.sla_settings enable row level security;
create policy "time limits readable" on public.sla_settings for select to authenticated using (public.is_active_user());
create policy "time limits admin" on public.sla_settings for update to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));
grant select, update (minutes) on public.sla_settings to authenticated;
create trigger audit_change after update on public.sla_settings for each row execute function public.audit_table_change();

alter table public.routing_rules
  add column sla_minutes integer check (sla_minutes between 1 and 43200),
  add column on_overdue text not null default 'reject' check (on_overdue in ('reject', 'escalate')),
  add column overdue_escalate_to uuid references public.profiles (id),
  add constraint escalate_needs_person check (on_overdue = 'reject' or overdue_escalate_to is not null);

-- The rule check from task 2.3, now also checking the "escalate to" person.
create or replace function public.routing_rules_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  if not exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                 where r.user_id = new.approver_id and r.role = 'approver' and p.is_active) then
    raise exception 'The approver must be an active user with the Approver role' using errcode = 'check_violation';
  end if;
  if new.on_overdue = 'reject' then
    new.overdue_escalate_to := null;
  elsif new.overdue_escalate_to is null then
    raise exception 'Choose who it goes to when nobody decides in time' using errcode = 'check_violation';
  elsif new.overdue_escalate_to = new.approver_id then
    raise exception 'Escalate to someone other than the rule''s approver' using errcode = 'check_violation';
  elsif not exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                    where r.user_id = new.overdue_escalate_to and r.role = 'approver' and p.is_active) then
    raise exception 'The person to escalate to must be an active user with the Approver role' using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- The clock on each request
-- ---------------------------------------------------------------------------
alter table public.action_requests
  add column due_at timestamptz,            -- decide by; empty = no limit
  add column sla_minutes integer,           -- the limit that applies
  add column sla_escalate_to uuid references public.profiles (id),  -- who gets it when overdue (empty = it expires)
  add column sla_escalated_at timestamptz;  -- the timer escalates only once
create index action_requests_due on public.action_requests (due_at) where status = 'pending';

/** "30 minutes", "2 hours", "1 day", "90 minutes". */
create function public.minutes_text(m integer) returns text
language sql immutable set search_path = '' as $$
  select case when m % 1440 = 0 then (m / 1440) || case when m = 1440 then ' day' else ' days' end
              when m % 60 = 0 then (m / 60) || case when m = 60 then ' hour' else ' hours' end
              else m || case when m = 1 then ' minute' else ' minutes' end end
$$;

-- Sets the limit when a request starts waiting, and gives a fresh limit whenever it moves to another person.
create function public.action_requests_sla() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rule public.routing_rules;
  limit_minutes integer;
begin
  if new.status <> 'pending' then return new; end if;
  if tg_op = 'UPDATE' and new.assigned_to is not distinct from old.assigned_to
     and new.routing_rule_id is not distinct from old.routing_rule_id then
    return new;
  end if;
  -- A request that was waiting before time limits existed keeps having none.
  if tg_op = 'UPDATE' and old.due_at is null then return new; end if;

  select * into rule from public.routing_rules where id = new.routing_rule_id;
  if tg_op = 'INSERT' or new.routing_rule_id is distinct from old.routing_rule_id then
    select coalesce(rule.sla_minutes, s.minutes) into limit_minutes from public.sla_settings s where s.urgency = new.urgency;
    new.sla_minutes := coalesce(limit_minutes, 480);
    new.sla_escalate_to := case when rule.on_overdue = 'escalate' then rule.overdue_escalate_to end;
  end if;
  if new.sla_escalate_to is not distinct from new.assigned_to then new.sla_escalate_to := null; end if;
  new.due_at := now() + make_interval(mins => new.sla_minutes);
  return new;
end $$;

-- Runs after the routing trigger (trigger names run in alphabetical order: action_requests_route < action_requests_sla).
create trigger action_requests_sla before insert or update of assigned_to, routing_rule_id on public.action_requests
  for each row execute function public.action_requests_sla();

-- ---------------------------------------------------------------------------
-- The timer
-- ---------------------------------------------------------------------------
create function public.sla_sweep() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r public.action_requests;
  a public.agents;
  target public.profiles;
  can_take boolean;
  n integer := 0;
  late text;
begin
  perform set_config('act.actor_type', 'system', true);
  for r in select * from public.action_requests
            where status = 'pending' and due_at is not null and due_at <= now()
            order by due_at for update skip locked loop
    select * into a from public.agents where id = r.agent_id;
    late := 'No decision within ' || public.minutes_text(r.sla_minutes);
    select * into target from public.profiles where id = r.sla_escalate_to;
    can_take := r.sla_escalated_at is null and target.id is not null and target.is_active
      and exists (select 1 from public.user_roles where user_id = target.id and role = 'approver')
      and target.id is distinct from r.assigned_to
      and target.id not in (coalesce(a.business_owner_id, gen_random_uuid()), coalesce(a.technical_owner_id, gen_random_uuid()),
                            coalesce(a.created_by, gen_random_uuid()));
    if can_take then
      perform set_config('act.reason', late || ': escalated automatically to ' || target.full_name, true);
      update public.action_requests
         set assigned_to = target.id, routed_at = now(),
             routing_note = format('%s: escalated automatically to %s', late, target.full_name),
             escalated_by = null, escalated_at = now(), escalation_reason = late || ', so it was escalated automatically',
             sla_escalated_at = now()
       where id = r.id;
    else
      perform set_config('act.reason', late || ': expired', true);
      update public.action_requests
         set status = 'expired', decision_source = 'timeout', decided_at = now(),
             decision_reason = late || ', so it was not allowed. The agent must not proceed.'
       where id = r.id;
    end if;
    n := n + 1;
  end loop;
  perform set_config('act.reason', '', true);
  perform set_config('act.actor_type', '', true);
  return n;
end $$;

do $$
begin
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'sla-sweep') then
      perform cron.unschedule('sla-sweep');
    end if;
    perform cron.schedule('sla-sweep', '* * * * *', 'select public.sla_sweep()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Fix (from task 2.3): deleting a routing rule clears routing_rule_id on the requests it routed ("on delete set null").
-- The guard refused that for decided requests, so a rule that had ever routed a decided request could not be deleted.
-- A decided request may now lose only that link (or its link to a deleted key); everything else stays locked.
-- ---------------------------------------------------------------------------
create or replace function public.action_requests_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status <> 'pending' then
    if new.routing_rule_id is null and new.api_key_id is not distinct from old.api_key_id
       and (to_jsonb(new) - 'routing_rule_id') = (to_jsonb(old) - 'routing_rule_id') then
      return new;
    end if;
    if new.api_key_id is null and (to_jsonb(new) - 'api_key_id') = (to_jsonb(old) - 'api_key_id') then
      return new;
    end if;
    raise exception 'Request % was already decided (%)', old.request_code, old.status using errcode = 'check_violation';
  end if;
  if new.agent_id <> old.agent_id or new.idempotency_key <> old.idempotency_key or new.request_hash <> old.request_hash then
    raise exception 'The request itself cannot be changed, only decided' using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on function public.minutes_text(integer), public.action_requests_sla(), public.sla_sweep()
  from public, anon, authenticated;
grant execute on function public.minutes_text(integer) to authenticated;
