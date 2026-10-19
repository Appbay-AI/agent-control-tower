-- Phase 2, task 2.4: the approver's task. The person a waiting action request is routed to sees what the agent wants
-- and why, then approves, rejects with a reason, or escalates to another approver with a reason.
-- Who decides: the assigned approver; when nobody is assigned, any approver for the agent's department.
-- Never the agent's owners or creator. Every decision and escalation is in the audit trail with its reason.

alter table public.action_requests
  -- Why it waited for a person (the policy's words), kept when the decision reason is replaced by the approver's.
  add column hold_reason text,
  add column escalated_by uuid references public.profiles (id),
  add column escalated_at timestamptz,
  add column escalation_reason text;

update public.action_requests set hold_reason = decision_reason where status = 'pending';

-- Same routing as task 2.3, now also keeping the hold reason.
create or replace function public.action_requests_route() returns trigger
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
    new.hold_reason := new.decision_reason;
  end if;
  return new;
end $$;

-- Re-applying rules leaves escalated requests with the person they were escalated to.
create or replace function public.reroute_pending_requests() returns integer
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
  for req in select * from public.action_requests where status = 'pending' and escalated_at is null for update loop
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

-- May the signed-in person decide this request?
create function public.can_decide_request(r public.action_requests) returns boolean
language sql stable security definer set search_path = '' as $$
  select r.status = 'pending'
     and public.is_active_user()
     and public.has_role('approver')
     and exists (
       select 1 from public.agents a
       where a.id = r.agent_id
         and auth.uid() is distinct from a.business_owner_id
         and auth.uid() is distinct from a.technical_owner_id
         and auth.uid() is distinct from a.created_by
         and case when r.assigned_to is not null then r.assigned_to = auth.uid()
                  else public.in_approver_scope(a.department_id) end)
$$;

-- Locks a waiting request the caller may act on, or says plainly why not.
create function public.lock_request_for_decision(p_request_id uuid) returns public.action_requests
language plpgsql security definer set search_path = '' as $$
declare
  r public.action_requests;
  a public.agents;
begin
  select * into r from public.action_requests where id = p_request_id for update;
  if not found or not public.can_see_agent(r.agent_id) then
    raise exception 'This request doesn''t exist, or you don''t have access to it' using errcode = 'no_data_found';
  end if;
  if r.status <> 'pending' then
    raise exception '% was already decided (%)', r.request_code, r.status using errcode = 'check_violation';
  end if;
  select * into a from public.agents where id = r.agent_id;
  if auth.uid() in (a.business_owner_id, a.technical_owner_id, a.created_by) then
    raise exception 'You cannot decide on an action by an agent you own or created' using errcode = 'insufficient_privilege';
  end if;
  if not public.can_decide_request(r) then
    raise exception '% is assigned to someone else', r.request_code using errcode = 'insufficient_privilege';
  end if;
  return r;
end $$;

create function public.decide_action_request(p_request_id uuid, p_decision text, p_reason text default null)
returns public.action_request_status
language plpgsql security definer set search_path = '' as $$
declare
  r public.action_requests;
  a public.agents;
  me text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_status public.action_request_status;
begin
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'The decision must be approve or reject' using errcode = 'check_violation';
  end if;
  r := public.lock_request_for_decision(p_request_id);
  select * into a from public.agents where id = r.agent_id;
  if p_decision = 'reject' and v_reason is null then
    raise exception 'Say why it is rejected; the agent and its owner will see the reason' using errcode = 'check_violation';
  end if;
  -- Fail closed: an agent that was suspended or retired since it asked cannot be given the go-ahead.
  if p_decision = 'approve' and a.status <> 'live' then
    raise exception '% is now %, so this action cannot be approved. Reject it instead.', a.agent_code, a.status
      using errcode = 'check_violation';
  end if;

  select full_name into me from public.profiles where id = auth.uid();
  v_status := case when p_decision = 'approve' then 'approved' else 'rejected' end;
  perform set_config('act.reason', coalesce(v_reason, ''), true);
  update public.action_requests
     set status = v_status, decision_source = 'human', decided_by = auth.uid(), decided_at = now(),
         decision_reason = concat(case when v_status = 'approved' then 'Approved' else 'Rejected' end, ' by ', me,
                                  case when v_reason is not null then ': ' || v_reason end)
   where id = r.id;
  perform set_config('act.reason', '', true);
  return v_status;
end $$;

create function public.escalate_action_request(p_request_id uuid, p_to uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.action_requests;
  a public.agents;
  me text;
  them public.profiles;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  r := public.lock_request_for_decision(p_request_id);
  select * into a from public.agents where id = r.agent_id;
  if v_reason is null then
    raise exception 'Say why you are escalating it' using errcode = 'check_violation';
  end if;
  select * into them from public.profiles where id = p_to;
  if not found or not them.is_active
     or not exists (select 1 from public.user_roles where user_id = p_to and role = 'approver') then
    raise exception 'Escalate to an active user with the Approver role' using errcode = 'check_violation';
  end if;
  if p_to = auth.uid() then
    raise exception 'Choose someone other than yourself' using errcode = 'check_violation';
  end if;
  if p_to in (a.business_owner_id, a.technical_owner_id, a.created_by) then
    raise exception '% owns or created this agent, so cannot decide on it', them.full_name using errcode = 'check_violation';
  end if;

  select full_name into me from public.profiles where id = auth.uid();
  perform set_config('act.reason', v_reason, true);
  update public.action_requests
     set assigned_to = p_to, routing_rule_id = null, routed_at = now(),
         routing_note = format('Escalated by %s to %s: %s', me, them.full_name, v_reason),
         escalated_by = auth.uid(), escalated_at = now(), escalation_reason = v_reason
   where id = r.id;
  perform set_config('act.reason', '', true);
end $$;

-- Who a request can be escalated to: active approvers other than the caller and the agent's owners and creator.
create function public.escalation_targets(p_request_id uuid)
returns table (id uuid, full_name text, job_title text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, p.job_title
  from public.action_requests r
  join public.agents a on a.id = r.agent_id
  join public.user_roles ur on ur.role = 'approver'
  join public.profiles p on p.id = ur.user_id and p.is_active
  where r.id = p_request_id
    and public.can_decide_request(r)
    and p.id <> auth.uid()
    and p.id is distinct from a.business_owner_id
    and p.id is distinct from a.technical_owner_id
    and p.id is distinct from a.created_by
  order by p.full_name
$$;

revoke execute on function
  public.action_requests_route(), public.reroute_pending_requests(), public.can_decide_request(public.action_requests),
  public.lock_request_for_decision(uuid), public.decide_action_request(uuid, text, text),
  public.escalate_action_request(uuid, uuid, text), public.escalation_targets(uuid)
  from public, anon, authenticated;
grant execute on function
  public.reroute_pending_requests(), public.decide_action_request(uuid, text, text),
  public.escalate_action_request(uuid, uuid, text), public.escalation_targets(uuid)
  to authenticated;
