-- Task 4.1: the kill switch. One action, with a reason, suspends a Live agent at once. From that moment every check
-- the agent makes with the Control Tower says it may not act (status check, check-in, action request), and approvers
-- can no longer approve what it asked for. Blocking it inside its platform (Appian), stop webhooks and owner emails
-- are task 4.2; bringing it back is task 4.6 (through an approval, never a toggle).
--
-- Who may pull it: admins, the agent's business or technical owner, and approvers whose departments cover the agent.
-- Executives and auditors see it but cannot pull it.
--
-- Critical agents: admins can require a second person ("four-eyes"). The setting is off by default, so the switch is
-- instant. When it is on, the first person's press records a request and alerts the others who may pull the switch; the
-- agent is suspended when a different person confirms it. The requester or an admin can withdraw a request.

create table public.kill_switch_settings (
  id boolean primary key default true check (id),
  critical_needs_second boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.kill_switch_settings default values;
alter table public.kill_switch_settings enable row level security;
create policy "kill switch settings readable" on public.kill_switch_settings for select to authenticated using (public.is_active_user());
revoke all on public.kill_switch_settings from anon, authenticated;
grant select on public.kill_switch_settings to authenticated;
-- Audited by set_kill_switch_settings (its key is not a uuid, so the generic audit trigger does not fit).

-- Every press of the kill switch, kept for the record (and for the incident case, task 4.4).
create table public.agent_suspensions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  status text not null check (status in ('waiting', 'done', 'withdrawn')),
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  requested_by uuid not null references public.profiles (id),
  requested_at timestamptz not null default now(),
  confirmed_by uuid references public.profiles (id),
  confirmed_at timestamptz,
  confirm_note text check (length(confirm_note) <= 2000),
  withdrawn_by uuid references public.profiles (id),
  withdrawn_at timestamptz,
  withdraw_reason text check (length(withdraw_reason) <= 2000),
  suspended_at timestamptz                          -- when the agent actually stopped
);
create unique index agent_suspensions_one_waiting on public.agent_suspensions (agent_id) where status = 'waiting';
create index agent_suspensions_agent on public.agent_suspensions (agent_id, requested_at desc);
alter table public.agent_suspensions enable row level security;
create policy "suspensions visible with the agent" on public.agent_suspensions for select to authenticated
  using (public.can_see_agent(agent_id));
revoke all on public.agent_suspensions from anon, authenticated;
grant select on public.agent_suspensions to authenticated;
create trigger audit_change after insert or update or delete on public.agent_suspensions
  for each row execute function public.audit_table_change();

alter table public.push_outbox drop constraint push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check
  check (kind in ('action_request', 'test', 'agent_discovered', 'suspension'));

-- ---------------------------------------------------------------------------
-- Who may pull the switch on an agent
-- ---------------------------------------------------------------------------
create function public.can_suspend_agent(p_agent uuid, p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.agents a join public.profiles p on p.id = p_user and p.is_active
     where a.id = p_agent
       and (exists (select 1 from public.user_roles r where r.user_id = p_user and r.role = 'admin')
            or p_user in (a.business_owner_id, a.technical_owner_id)
            or (exists (select 1 from public.user_roles r where r.user_id = p_user and r.role = 'approver')
                and exists (select 1 from public.approver_scopes s where s.user_id = p_user and s.department_id = a.department_id))))
$$;

-- The agent stops: status Suspended, recorded with the reason (audited as an agent status change).
create function public.agent_suspend_now(p_suspension uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.agent_suspensions;
begin
  select * into s from public.agent_suspensions where id = p_suspension for update;
  -- Marked done first, so the status trigger below does not treat it as a request left waiting.
  update public.agent_suspensions set status = 'done', suspended_at = now() where id = s.id;
  perform public.begin_governed_change(format('Suspended: %s', s.reason));
  update public.agents set status = 'suspended' where id = s.agent_id and status = 'live';
  perform public.end_governed_change();
end $$;

-- ---------------------------------------------------------------------------
-- Pull the switch. Returns 'suspended', or 'waiting' when a Critical agent needs a second person.
-- ---------------------------------------------------------------------------
create function public.suspend_agent(p_agent uuid, p_reason text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  s_id uuid;
  needs_second boolean;
begin
  select * into a from public.agents where id = p_agent for update;
  if not found or not public.can_see_agent(p_agent) then
    raise exception 'Agent not found' using errcode = 'no_data_found';
  end if;
  if not public.can_suspend_agent(p_agent) then
    raise exception 'Only admins, the agent''s owners and approvers for its department can suspend it' using errcode = 'insufficient_privilege';
  end if;
  if a.status <> 'live' then
    raise exception 'Only Live agents can be suspended (% is %)', a.agent_code, a.status using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Say why the agent is being suspended' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.agent_suspensions where agent_id = p_agent and status = 'waiting') then
    raise exception 'A suspension of % is already waiting for a second person' , a.agent_code using errcode = 'check_violation';
  end if;

  select critical_needs_second into needs_second from public.kill_switch_settings;
  insert into public.agent_suspensions (agent_id, status, reason, requested_by)
  values (p_agent, 'waiting', btrim(p_reason), auth.uid())
  returning id into s_id;

  if a.risk_tier = 'critical' and coalesce(needs_second, false) then
    -- Tell the others who may pull the switch.
    insert into public.push_outbox (user_id, kind, title, body, url)
    select p.id, 'suspension', 'Confirm suspension · ' || a.agent_code,
           format('%s asked to suspend %s: %s', (select full_name from public.profiles where id = auth.uid()), a.name, btrim(p_reason)),
           '/agents/' || a.id
      from public.profiles p
     where p.is_active and p.id <> auth.uid() and public.can_suspend_agent(a.id, p.id);
    return 'waiting';
  end if;

  perform public.agent_suspend_now(s_id);
  return 'suspended';
end $$;

-- A second person confirms a waiting suspension of a Critical agent.
create function public.confirm_agent_suspension(p_suspension uuid, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  s public.agent_suspensions;
  a public.agents;
begin
  select * into s from public.agent_suspensions where id = p_suspension for update;
  if not found or not public.can_see_agent(s.agent_id) then
    raise exception 'Suspension request not found' using errcode = 'no_data_found';
  end if;
  if s.status <> 'waiting' then
    raise exception 'This suspension request is no longer waiting (%)', s.status using errcode = 'check_violation';
  end if;
  if not public.can_suspend_agent(s.agent_id) then
    raise exception 'Only admins, the agent''s owners and approvers for its department can confirm a suspension' using errcode = 'insufficient_privilege';
  end if;
  if s.requested_by = auth.uid() then
    raise exception 'A second person must confirm; you asked for this suspension' using errcode = 'insufficient_privilege';
  end if;
  select * into a from public.agents where id = s.agent_id;
  if a.status <> 'live' then
    update public.agent_suspensions set status = 'withdrawn', withdrawn_at = now(), withdraw_reason = format('The agent is %s', a.status)
     where id = s.id;
    raise exception '% is no longer Live (%)', a.agent_code, a.status using errcode = 'check_violation';
  end if;
  update public.agent_suspensions
     set confirmed_by = auth.uid(), confirmed_at = now(), confirm_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = s.id;
  perform public.agent_suspend_now(s.id);
  return 'suspended';
end $$;

-- The requester or an admin withdraws a waiting request.
create function public.withdraw_agent_suspension(p_suspension uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.agent_suspensions;
begin
  select * into s from public.agent_suspensions where id = p_suspension for update;
  if not found or not public.can_see_agent(s.agent_id) then
    raise exception 'Suspension request not found' using errcode = 'no_data_found';
  end if;
  if s.status <> 'waiting' then
    raise exception 'This suspension request is no longer waiting (%)', s.status using errcode = 'check_violation';
  end if;
  if not (s.requested_by = auth.uid() or public.has_role('admin')) then
    raise exception 'Only the person who asked, or an admin, can withdraw it' using errcode = 'insufficient_privilege';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Say why the request is withdrawn' using errcode = 'check_violation';
  end if;
  update public.agent_suspensions
     set status = 'withdrawn', withdrawn_by = auth.uid(), withdrawn_at = now(), withdraw_reason = btrim(p_reason)
   where id = s.id;
end $$;

-- Admins switch four-eyes for Critical agents on or off (audited).
create function public.set_kill_switch_settings(p_critical_needs_second boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can change the kill switch settings' using errcode = 'insufficient_privilege';
  end if;
  update public.kill_switch_settings set critical_needs_second = coalesce(p_critical_needs_second, false), updated_at = now()
   where critical_needs_second is distinct from coalesce(p_critical_needs_second, false);
  if found then
    insert into public.audit_events (actor_id, actor_type, action, entity_type, summary, reason, before, after)
    values (auth.uid(), 'user', 'kill_switch_settings.update', 'kill_switch_settings',
            case when p_critical_needs_second then 'Suspending a Critical agent now needs a second person'
                 else 'Critical agents are suspended at once' end,
            case when p_critical_needs_second then 'Critical agents need a second person to suspend'
                 else 'Critical agents are suspended at once' end,
            jsonb_build_object('critical_needs_second', not coalesce(p_critical_needs_second, false)),
            jsonb_build_object('critical_needs_second', coalesce(p_critical_needs_second, false)));
  end if;
end $$;

-- If an agent is retired or suspended some other way while a request waits, the request is closed.
create function public.agent_suspensions_close_waiting() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'live' and new.status <> 'live' then
    update public.agent_suspensions
       set status = 'withdrawn', withdrawn_at = now(), withdraw_reason = format('The agent became %s', new.status)
     where agent_id = new.id and status = 'waiting';
  end if;
  return null;
end $$;
create trigger agent_suspensions_close_waiting after update of status on public.agents
  for each row execute function public.agent_suspensions_close_waiting();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on function public.can_suspend_agent(uuid, uuid), public.agent_suspend_now(uuid), public.suspend_agent(uuid, text),
  public.confirm_agent_suspension(uuid, text), public.withdraw_agent_suspension(uuid, text), public.set_kill_switch_settings(boolean),
  public.agent_suspensions_close_waiting()
  from public, anon, authenticated;
grant execute on function public.can_suspend_agent(uuid, uuid), public.suspend_agent(uuid, text), public.confirm_agent_suspension(uuid, text),
  public.withdraw_agent_suspension(uuid, text), public.set_kill_switch_settings(boolean) to authenticated;
