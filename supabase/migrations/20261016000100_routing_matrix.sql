-- Phase 2, task 2.3: the routing matrix. Decides who approves a waiting action request, from rules an admin edits on
-- a screen: no code, no deploy. Rules are checked in priority order; the first one that matches and whose approver may
-- act (active, holds the Approver role, does not own or create the agent) wins. No match: any approver whose scope
-- covers the agent's department, exactly as for registrations.

create table public.routing_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  priority integer not null default 100 check (priority between 1 and 9999),
  is_active boolean not null default true,
  -- Conditions: a blank condition matches anything.
  agent_id uuid references public.agents (id) on delete cascade,
  department_id uuid references public.departments (id) on delete cascade,
  min_amount numeric(18, 2) check (min_amount >= 0),
  max_amount numeric(18, 2) check (max_amount > 0),
  currency char(3) check (currency ~ '^[A-Z]{3}$'),
  data_classification public.data_classification,
  min_risk_tier public.risk_tier,
  -- Who approves.
  approver_id uuid not null references public.profiles (id),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint band_needs_currency check ((min_amount is null and max_amount is null) or currency is not null),
  constraint band_in_order check (min_amount is null or max_amount is null or min_amount < max_amount)
);

create index routing_rules_order on public.routing_rules (priority, created_at) where is_active;

create function public.routing_rules_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  if not exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                 where r.user_id = new.approver_id and r.role = 'approver' and p.is_active) then
    raise exception 'The approver must be an active user with the Approver role' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger routing_rules_check before insert or update on public.routing_rules
  for each row execute function public.routing_rules_check();
create trigger audit_change after insert or update or delete on public.routing_rules
  for each row execute function public.audit_table_change();

alter table public.routing_rules enable row level security;
create policy "routing rules readable" on public.routing_rules for select to authenticated
  using (public.sees_everything() or public.has_role('approver'));
create policy "routing rules admin" on public.routing_rules for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));
grant select, insert, update, delete on public.routing_rules to authenticated;

-- ---------------------------------------------------------------------------
-- Where each pending request went, and why.
-- ---------------------------------------------------------------------------
alter table public.action_requests
  add column assigned_to uuid references public.profiles (id),
  add column routing_rule_id uuid references public.routing_rules (id) on delete set null,
  add column routing_note text,
  add column routed_at timestamptz;

create index action_requests_assignee on public.action_requests (assigned_to) where status = 'pending';

-- The decision on who approves. Pure: no writes.
create function public.route_request(a public.agents, p_amount numeric, p_currency text)
returns table (rule_id uuid, assigned_to uuid, note text)
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.routing_rules;
  who public.profiles;
  skipped text[] := '{}';
  dept text;
begin
  for r in select * from public.routing_rules where is_active order by priority, created_at loop
    continue when r.agent_id is not null and r.agent_id <> a.id;
    continue when r.department_id is not null and r.department_id is distinct from a.department_id;
    if r.min_amount is not null or r.max_amount is not null then
      continue when p_amount is null or p_currency is distinct from r.currency;
      continue when r.min_amount is not null and p_amount < r.min_amount;
      continue when r.max_amount is not null and p_amount >= r.max_amount;
    end if;
    continue when r.data_classification is not null and not (r.data_classification = any (a.data_classifications));
    continue when r.min_risk_tier is not null and a.risk_tier < r.min_risk_tier;

    select * into who from public.profiles where id = r.approver_id;
    if not who.is_active or not exists (select 1 from public.user_roles where user_id = who.id and role = 'approver') then
      skipped := skipped || format('rule "%s" skipped: %s is not an active approver', r.name, who.full_name);
      continue;
    end if;
    if who.id in (a.business_owner_id, a.technical_owner_id, a.created_by) then
      skipped := skipped || format('rule "%s" skipped: %s owns or created this agent', r.name, who.full_name);
      continue;
    end if;
    return query select r.id, who.id,
      concat_ws('. ', format('Rule "%s" assigned it to %s', r.name, who.full_name), nullif(array_to_string(skipped, '; '), ''));
    return;
  end loop;

  select name into dept from public.departments where id = a.department_id;
  return query select null::uuid, null::uuid,
    concat_ws('. ', format('No rule matched: any approver for %s may decide', coalesce(dept, 'its department')),
              nullif(array_to_string(skipped, '; '), ''));
end $$;

-- Route every new pending request as it is recorded.
create function public.action_requests_route() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  rt record;
begin
  if new.status = 'pending' then
    select * into a from public.agents where id = new.agent_id;
    select * into rt from public.route_request(a, new.amount, new.currency);
    new.routing_rule_id := rt.rule_id;
    new.assigned_to := rt.assigned_to;
    new.routing_note := rt.note;
    new.routed_at := now();
  end if;
  return new;
end $$;

create trigger action_requests_route before insert on public.action_requests
  for each row execute function public.action_requests_route();

-- After rules change, an admin can apply them to requests that are still waiting.
create function public.reroute_pending_requests() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  req public.action_requests;
  a public.agents;
  rt record;
  n integer := 0;
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can re-route requests' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('act.reason', 'Routing rules re-applied by admin', true);
  for req in select * from public.action_requests where status = 'pending' for update loop
    select * into a from public.agents where id = req.agent_id;
    select * into rt from public.route_request(a, req.amount, req.currency);
    if rt.assigned_to is distinct from req.assigned_to or rt.rule_id is distinct from req.routing_rule_id then
      update public.action_requests
         set assigned_to = rt.assigned_to, routing_rule_id = rt.rule_id, routing_note = rt.note, routed_at = now()
       where id = req.id;
      n := n + 1;
    end if;
  end loop;
  perform set_config('act.reason', '', true);
  return n;
end $$;

-- "Test a request" on the routing screen: which rule and approver would a request get?
create function public.preview_routing(p_agent_id uuid, p_amount numeric, p_currency text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a public.agents;
  rt record;
begin
  if not (public.has_role('admin') or public.has_role('approver') or public.sees_everything()) then
    raise exception 'Only admins and approvers can preview routing' using errcode = 'insufficient_privilege';
  end if;
  select * into a from public.agents where id = p_agent_id;
  if not found then raise exception 'Agent not found' using errcode = 'no_data_found'; end if;
  select * into rt from public.route_request(a, p_amount, upper(nullif(trim(p_currency), '')));
  return jsonb_build_object(
    'rule_id', rt.rule_id,
    'rule_name', (select name from public.routing_rules where id = rt.rule_id),
    'approver_id', rt.assigned_to,
    'approver_name', (select full_name from public.profiles where id = rt.assigned_to),
    'note', rt.note,
    'department_approvers', coalesce((
      select jsonb_agg(p.full_name order by p.full_name)
      from public.approver_scopes s
      join public.user_roles ur on ur.user_id = s.user_id and ur.role = 'approver'
      join public.profiles p on p.id = s.user_id and p.is_active
      where s.department_id = a.department_id
        and p.id is distinct from a.business_owner_id and p.id is distinct from a.technical_owner_id
        and p.id is distinct from a.created_by), '[]'));
end $$;

-- ---------------------------------------------------------------------------
-- An assigned approver sees the request and its agent, even outside their department scope.
-- ---------------------------------------------------------------------------
create or replace function public.can_see_agent(p_agent_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.agents a
    where a.id = p_agent_id
      and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active)
      and (public.sees_everything()
           or auth.uid() in (a.business_owner_id, a.technical_owner_id, a.created_by)
           or public.in_approver_scope(a.department_id)
           or exists (select 1 from public.action_requests r where r.agent_id = a.id and r.assigned_to = auth.uid())))
$$;

create function public.is_assigned_to_agent(p_agent_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.action_requests r where r.agent_id = p_agent_id and r.assigned_to = auth.uid())
$$;

alter policy "agents visible in scope" on public.agents
  using (public.is_active_user() and (public.sees_everything()
         or auth.uid() in (business_owner_id, technical_owner_id, created_by)
         or public.in_approver_scope(department_id)
         or public.is_assigned_to_agent(id)));

revoke execute on function
  public.routing_rules_check(), public.route_request(public.agents, numeric, text), public.action_requests_route(),
  public.reroute_pending_requests(), public.preview_routing(uuid, numeric, text), public.is_assigned_to_agent(uuid)
  from public, anon, authenticated;
grant execute on function public.reroute_pending_requests(), public.preview_routing(uuid, numeric, text),
  public.is_assigned_to_agent(uuid) to authenticated;
