-- Phase 2, tasks 2.1 and 2.2: action requests. An agent asks before it acts; Control Tower records the
-- request exactly once (idempotency key) and decides at once from the agent's autonomy level and limits:
--   not Live            -> refused (fail closed)
--   level 1 Observe     -> refused (may read and recommend only)
--   level 2             -> pending (every action needs a human)
--   level 3             -> approved if within its value and 24-hour volume limits, otherwise pending
--   level 4             -> approved (acts alone; logged for sampling)
-- Pending requests are routed to approvers in task 2.3.

create type public.action_request_status as enum ('pending', 'approved', 'rejected', 'refused', 'expired', 'cancelled');
create type public.action_urgency as enum ('low', 'normal', 'high', 'critical');

create sequence public.action_request_code_seq;

create table public.action_requests (
  id uuid primary key default gen_random_uuid(),
  request_code text not null unique default ('REQ-' || lpad(nextval('public.action_request_code_seq')::text, 6, '0')),
  agent_id uuid not null references public.agents (id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  action text not null check (length(trim(action)) between 1 and 200),
  description text,
  target_system text,
  reasoning text,
  amount numeric(18, 2) check (amount >= 0),
  currency char(3) check (currency ~ '^[A-Z]{3}$'),
  volume integer not null default 1 check (volume >= 1),
  urgency public.action_urgency not null default 'normal',
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  callback_url text check (callback_url ~ '^https://'),
  -- What the rules were when the request arrived, so the decision can be explained later.
  autonomy_level smallint not null,
  value_threshold numeric,
  threshold_currency text,
  volume_threshold integer,
  status public.action_request_status not null,
  decision_source text check (decision_source in ('policy', 'human', 'timeout')),
  decision_reason text not null,
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  requested_at timestamptz not null default now(),
  unique (agent_id, idempotency_key),
  constraint amount_needs_currency check (amount is null or currency is not null),
  constraint decided_has_time check ((status = 'pending') = (decided_at is null))
);

create index action_requests_agent_time on public.action_requests (agent_id, requested_at desc);
create index action_requests_pending on public.action_requests (requested_at) where status = 'pending';

-- A decided request never changes again.
create function public.action_requests_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status <> 'pending' then
    raise exception 'Request % was already decided (%)', old.request_code, old.status using errcode = 'check_violation';
  end if;
  if new.agent_id <> old.agent_id or new.idempotency_key <> old.idempotency_key or new.request_hash <> old.request_hash then
    raise exception 'The request itself cannot be changed, only decided' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger action_requests_guard before update on public.action_requests
  for each row execute function public.action_requests_guard();
create trigger audit_change after insert or update or delete on public.action_requests
  for each row execute function public.audit_table_change();

alter table public.action_requests enable row level security;
create policy "action requests visible with agent" on public.action_requests for select to authenticated
  using (public.can_see_agent(agent_id));
grant select on public.action_requests to authenticated;

-- ---------------------------------------------------------------------------
-- The decision (task 2.2). Pure function of the agent and the request, so it is easy to test.
-- ---------------------------------------------------------------------------
create function public.decide_action(a public.agents, p_amount numeric, p_currency text, p_volume integer)
returns table (status public.action_request_status, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare
  used integer;
  over text[] := '{}';
begin
  if a.status <> 'live' then
    return query select 'refused'::public.action_request_status,
      format('%s is %s. Only Live agents may act.', a.agent_code, a.status);
    return;
  end if;

  case a.autonomy_level
    when 1 then
      return query select 'refused'::public.action_request_status,
        format('%s is level 1 (Observe): it may read and recommend only, never act.', a.agent_code);
    when 2 then
      return query select 'pending'::public.action_request_status,
        format('%s is level 2: every action needs a human approval first.', a.agent_code);
    when 4 then
      return query select 'approved'::public.action_request_status,
        format('%s is level 4: it acts alone; this action is logged for sampling.', a.agent_code);
    else -- level 3
      if p_amount is not null then
        if p_currency is distinct from a.threshold_currency then
          over := over || format('amount is in %s but the limit is in %s', p_currency, a.threshold_currency);
        elsif a.value_threshold is not null and p_amount > a.value_threshold then
          over := over || format('%s %s is above the %s %s limit', p_currency, to_char(p_amount, 'FM999G999G999G990D00'),
                                 a.threshold_currency, to_char(a.value_threshold, 'FM999G999G999G990D00'));
        end if;
      end if;
      if a.volume_threshold is not null then
        select coalesce(sum(r.volume), 0) into used from public.action_requests r
        where r.agent_id = a.id and r.status = 'approved' and r.requested_at > now() - interval '24 hours';
        if used + p_volume > a.volume_threshold then
          over := over || format('%s actions in 24 hours would exceed the limit of %s', used + p_volume, a.volume_threshold);
        end if;
      end if;
      if cardinality(over) > 0 then
        return query select 'pending'::public.action_request_status,
          format('%s is level 3 and this is outside its limits: %s. A human must approve.', a.agent_code, array_to_string(over, '; '));
      else
        return query select 'approved'::public.action_request_status,
          format('%s is level 3 and this is within its limits.', a.agent_code);
      end if;
  end case;
end $$;

-- ---------------------------------------------------------------------------
-- API: POST /api/v1/actions/request and GET /api/v1/actions/{id}
-- ---------------------------------------------------------------------------
create function public.action_request_json(r public.action_requests, p_duplicate boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'request_id', r.id,
    'request_code', r.request_code,
    'agent_code', a.agent_code,
    'status', r.status,
    -- Proceed only when approved AND the agent is still Live (it may have been suspended since).
    'may_proceed', r.status = 'approved' and a.status = 'live',
    'decision_source', r.decision_source,
    'reason', case when r.status = 'approved' and a.status <> 'live'
                   then format('Approved, but %s is now %s. Do not proceed.', a.agent_code, a.status)
                   else r.decision_reason end,
    'requested_at', r.requested_at,
    'decided_at', r.decided_at,
    'duplicate', p_duplicate)
  from public.agents a where a.id = r.agent_id
$$;

create function public.agent_for_key(p_agent_key text) returns public.agents
language plpgsql security definer set search_path = '' as $$
declare
  k public.agent_api_keys;
  a public.agents;
begin
  select * into k from public.agent_api_keys
  where key_hash = public.secret_hash(coalesce(p_agent_key, '')) and revoked_at is null;
  if not found then raise exception 'Invalid or revoked agent key' using errcode = 'invalid_authorization_specification'; end if;
  update public.agent_api_keys set last_used_at = now() where id = k.id;
  select * into a from public.agents where id = k.agent_id;
  return a;
end $$;

create function public.api_request_action(p_agent_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  r public.action_requests;
  v_key text := trim(coalesce(p_payload ->> 'idempotency_key', ''));
  v_action text := trim(coalesce(p_payload ->> 'action', ''));
  v_amount numeric;
  v_currency text := upper(nullif(trim(coalesce(p_payload ->> 'currency', '')), ''));
  v_volume integer;
  v_urgency public.action_urgency;
  v_hash text;
  d record;
begin
  a := public.agent_for_key(p_agent_key);
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'The request body must be a JSON object' using errcode = 'check_violation';
  end if;

  -- Validation, with messages an integrator can act on.
  if v_key = '' or length(v_key) > 200 then
    raise exception 'idempotency_key is required (1 to 200 characters); send the same key when retrying the same request'
      using errcode = 'check_violation';
  end if;
  if v_action = '' or length(v_action) > 200 then
    raise exception 'action is required (1 to 200 characters), e.g. "payment.release"' using errcode = 'check_violation';
  end if;
  begin
    v_amount := (p_payload ->> 'amount')::numeric;
    v_volume := coalesce((p_payload ->> 'volume')::integer, 1);
    v_urgency := coalesce((p_payload ->> 'urgency')::public.action_urgency, 'normal');
  exception when others then
    raise exception 'amount must be a number, volume a whole number, urgency one of low, normal, high, critical'
      using errcode = 'check_violation';
  end;
  if v_amount is not null and v_amount < 0 then
    raise exception 'amount cannot be negative' using errcode = 'check_violation';
  end if;
  if v_amount is not null and (v_currency is null or v_currency !~ '^[A-Z]{3}$') then
    raise exception 'currency is required with amount, as a 3-letter code such as GBP' using errcode = 'check_violation';
  end if;
  if v_volume < 1 then
    raise exception 'volume must be 1 or more' using errcode = 'check_violation';
  end if;
  if p_payload ? 'details' and jsonb_typeof(p_payload -> 'details') <> 'object' then
    raise exception 'details must be a JSON object' using errcode = 'check_violation';
  end if;
  if coalesce(p_payload ->> 'callback_url', '') <> '' and p_payload ->> 'callback_url' !~ '^https://' then
    raise exception 'callback_url must start with https://' using errcode = 'check_violation';
  end if;

  -- Same key + same body = the same request: return the original answer. Same key + different body = a mistake.
  v_hash := public.secret_hash(p_payload::text);
  select * into r from public.action_requests where agent_id = a.id and idempotency_key = v_key;
  if found then
    if r.request_hash <> v_hash then
      raise exception 'idempotency_key % was already used for a different request', v_key using errcode = 'unique_violation';
    end if;
    return public.action_request_json(r, true);
  end if;

  perform set_config('act.actor_type', 'agent', true);
  perform set_config('act.actor_id', a.id::text, true);

  select * into d from public.decide_action(a, v_amount, v_currency, v_volume);
  insert into public.action_requests (
    agent_id, idempotency_key, request_hash, action, description, target_system, reasoning,
    amount, currency, volume, urgency, details, callback_url,
    autonomy_level, value_threshold, threshold_currency, volume_threshold,
    status, decision_source, decision_reason, decided_at)
  values (
    a.id, v_key, v_hash, v_action, p_payload ->> 'description', p_payload ->> 'target_system', p_payload ->> 'reasoning',
    v_amount, v_currency, v_volume, v_urgency, coalesce(p_payload -> 'details', '{}'), nullif(p_payload ->> 'callback_url', ''),
    a.autonomy_level, a.value_threshold, a.threshold_currency, a.volume_threshold,
    d.status, case when d.status = 'pending' then null else 'policy' end, d.reason,
    case when d.status = 'pending' then null else now() end)
  on conflict (agent_id, idempotency_key) do nothing
  returning * into r;

  if r.id is null then
    -- A simultaneous retry won the race; answer with the stored request.
    select * into r from public.action_requests where agent_id = a.id and idempotency_key = v_key;
    if r.request_hash <> v_hash then
      raise exception 'idempotency_key % was already used for a different request', v_key using errcode = 'unique_violation';
    end if;
    return public.action_request_json(r, true);
  end if;

  perform set_config('act.actor_type', '', true);
  perform set_config('act.actor_id', '', true);
  return public.action_request_json(r, false);
end $$;

create function public.api_action_status(p_agent_key text, p_request text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents := public.agent_for_key(p_agent_key);
  r public.action_requests;
begin
  select * into r from public.action_requests
  where agent_id = a.id and (request_code = upper(p_request) or id::text = lower(p_request));
  if not found then
    raise exception 'No request % for this agent', p_request using errcode = 'no_data_found';
  end if;
  return public.action_request_json(r, false);
end $$;

-- Functions: nobody by default, then exactly who needs each one. The API functions authenticate the caller
-- themselves by agent key hash, like api_agent_status.
revoke execute on function
  public.action_requests_guard(), public.decide_action(public.agents, numeric, text, integer),
  public.action_request_json(public.action_requests, boolean), public.agent_for_key(text),
  public.api_request_action(text, jsonb), public.api_action_status(text, text)
  from public, anon, authenticated;
grant execute on function public.api_request_action(text, jsonb), public.api_action_status(text, text) to anon;
