-- Phase 2, task 2.10: four-eyes approval for Critical agents, and bulk approval for low-risk ones.
--
-- Four-eyes: an action by an agent whose risk tier is Critical (when it asks) needs approval from two different
-- people. The first approval keeps it waiting and opens it to every other approver who could decide (alerts and
-- emails say "Second approval needed"); the second approval decides it. One rejection, at any stage, ends it.
-- Nobody approves twice, owners and creators never decide, and a person who approved cannot be escalated to.
-- Requests already waiting when this was released keep needing one approval.
--
-- Bulk: an approver can approve several waiting requests from Low-risk agents at once (up to 50). Each is decided and
-- audited on its own, exactly as if approved one by one; anything that is not low-risk or not theirs is left alone.

alter table public.action_requests add column required_approvals smallint not null default 1 check (required_approvals between 1 and 2);

create table public.action_request_approvals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.action_requests (id) on delete cascade,
  approver_id uuid not null references public.profiles (id),
  note text check (length(note) <= 1000),
  approved_at timestamptz not null default now(),
  unique (request_id, approver_id)
);
alter table public.action_request_approvals enable row level security;
create policy "approvals visible with the request" on public.action_request_approvals for select to authenticated
  using (exists (select 1 from public.action_requests r where r.id = request_id and public.can_see_agent(r.agent_id)));
grant select on public.action_request_approvals to authenticated;
create trigger audit_change after insert on public.action_request_approvals for each row execute function public.audit_table_change();

alter table public.email_outbox drop constraint email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check check (kind in ('new', 'escalated', 'second'));

-- Critical agents need two approvals (decided when the request is recorded).
create function public.action_requests_four_eyes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'pending' then
    new.required_approvals := case when (select risk_tier from public.agents where id = new.agent_id) = 'critical' then 2 else 1 end;
  end if;
  return new;
end $$;
create trigger action_requests_four_eyes before insert on public.action_requests
  for each row execute function public.action_requests_four_eyes();

create or replace function public.can_decide_request(r public.action_requests) returns boolean
language sql stable security definer set search_path = '' as $$
  select r.status = 'pending'
     and public.is_active_user()
     and public.has_role('approver')
     and not exists (select 1 from public.action_request_approvals x where x.request_id = r.id and x.approver_id = auth.uid())
     and exists (
       select 1 from public.agents a
       where a.id = r.agent_id
         and auth.uid() is distinct from a.business_owner_id
         and auth.uid() is distinct from a.technical_owner_id
         and auth.uid() is distinct from a.created_by
         and case when r.assigned_to is not null then r.assigned_to = auth.uid()
                  else public.in_approver_scope(a.department_id) end)
$$;

create or replace function public.request_deciders(r public.action_requests) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select p.id
  from public.profiles p
  join public.agents a on a.id = r.agent_id
  where r.status = 'pending'
    and p.is_active
    and exists (select 1 from public.user_roles ur where ur.user_id = p.id and ur.role = 'approver')
    and p.id is distinct from a.business_owner_id
    and p.id is distinct from a.technical_owner_id
    and p.id is distinct from a.created_by
    and not exists (select 1 from public.action_request_approvals x where x.request_id = r.id and x.approver_id = p.id)
    and case when r.assigned_to is not null then p.id = r.assigned_to
             else exists (select 1 from public.approver_scopes s where s.user_id = p.id and s.department_id = a.department_id) end
$$;

create or replace function public.decide_action_request(p_request_id uuid, p_decision text, p_reason text default null)
returns public.action_request_status
language plpgsql security definer set search_path = '' as $$
declare
  r public.action_requests;
  a public.agents;
  me text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_status public.action_request_status;
  v_count integer;
  v_final text;
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

  -- Four-eyes (task 2.10): a Critical agent's action needs two different approvers.
  if p_decision = 'approve' and r.required_approvals > 1 then
    insert into public.action_request_approvals (request_id, approver_id, note) values (r.id, auth.uid(), v_reason);
    select count(*) into v_count from public.action_request_approvals where request_id = r.id;
    if v_count < r.required_approvals then
      perform set_config('act.reason', coalesce(v_reason, 'First approval'), true);
      update public.action_requests
         set assigned_to = null, routed_at = now(),
             routing_note = format('Approved by %s (%s of %s)%s. A second approver must decide.', me, v_count, r.required_approvals,
                                   case when v_reason is not null then ': ' || v_reason else '' end),
             decision_reason = format('Approved by %s (%s of %s). Waiting for a second approver.', me, v_count, r.required_approvals)
       where id = r.id;
      perform set_config('act.reason', '', true);
      return 'pending';
    end if;
    select 'Approved by ' || string_agg(p.full_name || coalesce(' (' || x.note || ')', ''), ' and ' order by x.approved_at)
      into v_final from public.action_request_approvals x join public.profiles p on p.id = x.approver_id where x.request_id = r.id;
  end if;

  v_status := case when p_decision = 'approve' then 'approved' else 'rejected' end;
  perform set_config('act.reason', coalesce(v_reason, ''), true);
  update public.action_requests
     set status = v_status, decision_source = 'human', decided_by = auth.uid(), decided_at = now(),
         decision_reason = coalesce(v_final, concat(case when v_status = 'approved' then 'Approved' else 'Rejected' end, ' by ', me,
                                  case when v_reason is not null then ': ' || v_reason end))
   where id = r.id;
  perform set_config('act.reason', '', true);
  return v_status;
end $$;

create or replace function public.escalate_action_request(p_request_id uuid, p_to uuid, p_reason text) returns void
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
  if exists (select 1 from public.action_request_approvals where request_id = r.id and approver_id = p_to) then
    raise exception '% has already approved it; a second approver must be someone else', them.full_name using errcode = 'check_violation';
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

create or replace function public.escalation_targets(p_request_id uuid)
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
    and not exists (select 1 from public.action_request_approvals x where x.request_id = r.id and x.approver_id = p.id)
  order by p.full_name
$$;

create or replace function public.sla_sweep() returns integer
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
      and not exists (select 1 from public.action_request_approvals x where x.request_id = r.id and x.approver_id = target.id)
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

create or replace function public.action_requests_alert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  escalated boolean := new.escalated_at is not null and tg_op = 'UPDATE';
  second boolean := exists (select 1 from public.action_request_approvals where request_id = new.id);
  test text := coalesce(new.details ->> 'test', '');
begin
  if new.status <> 'pending' then return null; end if;
  if tg_op = 'UPDATE' and new.assigned_to is not distinct from old.assigned_to then return null; end if;
  insert into public.push_outbox (user_id, kind, request_id, title, body, url)
  select d, 'action_request', new.id,
         case when second then 'Second approval needed · ' when escalated then 'Escalated to you · ' else 'Approval needed · ' end || new.request_code,
         public.request_alert_body(new),
         '/approvals/requests/' || new.id
  from public.request_deciders(new) d;
  insert into public.email_outbox (user_id, request_id, kind, is_test, sent_at, result)
  select d, new.id, case when second then 'second' when escalated then 'escalated' else 'new' end, test in ('true', 'email'),
         case when test = 'true' then now() end,
         case when test = 'true' then 'Not sent: test request' end
  from public.request_deciders(new) d;
  return null;
end $$;

-- Bulk approval of low-risk requests. Returns one line per request: {id, code, ok, message}.
create function public.decide_action_requests_bulk(p_ids uuid[], p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  rid uuid;
  r public.action_requests;
  tier public.risk_tier;
  out jsonb := '[]'::jsonb;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if coalesce(array_length(p_ids, 1), 0) = 0 then
    raise exception 'Choose at least one request' using errcode = 'check_violation';
  end if;
  if array_length(p_ids, 1) > 50 then
    raise exception 'Approve at most 50 at a time' using errcode = 'check_violation';
  end if;
  foreach rid in array p_ids loop
    select * into r from public.action_requests where id = rid;
    select a.risk_tier into tier from public.agents a where a.id = r.agent_id;
    if r.id is null or not public.can_see_agent(r.agent_id) then
      out := out || jsonb_build_object('id', rid, 'code', null, 'ok', false, 'message', 'Not found');
    elsif tier is distinct from 'low' or r.required_approvals > 1 then
      out := out || jsonb_build_object('id', rid, 'code', r.request_code, 'ok', false,
                                       'message', 'Not a low-risk request: decide it on its own');
    else
      begin
        perform public.decide_action_request(rid, 'approve', 'Bulk approval' || coalesce(': ' || v_note, ''));
        out := out || jsonb_build_object('id', rid, 'code', r.request_code, 'ok', true, 'message', 'Approved');
      exception when others then
        out := out || jsonb_build_object('id', rid, 'code', r.request_code, 'ok', false, 'message', sqlerrm);
      end;
    end if;
  end loop;
  return out;
end $$;

revoke execute on function public.action_requests_four_eyes(), public.decide_action_requests_bulk(uuid[], text)
  from public, anon, authenticated;
grant execute on function public.decide_action_requests_bulk(uuid[], text) to authenticated;
-- The replaced functions keep their earlier grants (create or replace does not change them).
