-- Task 2.11: the agent log API and the silent-agent (heartbeat) check.
--
-- Agents write what they did into the Control Tower's log (POST /api/v1/agents/{id}/logs) and check in
-- (POST /api/v1/agents/{id}/heartbeat). Every call an agent makes with its key counts as being heard from.
-- An agent can be watched: "flag it if nothing is heard for N minutes". A minute job (pg_cron) raises an
-- "agent_silent" alert for a live, watched agent that has gone quiet, and the flag clears as soon as the agent
-- is heard from again. Logs are kept 90 days and can never be edited.

-- New alert kind. Used only inside plpgsql bodies, so adding it in the same transaction is safe.
alter type public.alert_kind add value if not exists 'agent_silent';

-- ---------------------------------------------------------------------------
-- The setting: flag the agent if nothing is heard from it for this many minutes (null = not watched).
-- Changed only through set_agent_silence_limit (admins and the agent's owners), audited as an agent change.
-- ---------------------------------------------------------------------------
alter table public.agents add column silent_after_minutes integer
  check (silent_after_minutes between 1 and 10080);
comment on column public.agents.silent_after_minutes is
  'Task 2.11: flag the agent as silent when nothing is heard from it for this many minutes. Null = not watched.';

-- ---------------------------------------------------------------------------
-- When each agent was last heard from. Updated on every API call, so it is not audited and not part of agents.
-- ---------------------------------------------------------------------------
create table public.agent_contact (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  last_seen_at timestamptz,          -- last call the agent made with its key
  last_seen_via text,                -- 'check-in', 'log entry', 'status check' or 'API call'
  last_note text,                    -- what the agent said in its last check-in, if anything
  watch_from timestamptz             -- silence is counted from here at the earliest (watching started, or went live)
);
alter table public.agent_contact enable row level security;
create policy "contact visible with agent" on public.agent_contact for select to authenticated
  using (public.can_see_agent(agent_id));
grant select on public.agent_contact to authenticated;

-- ---------------------------------------------------------------------------
-- The agent log. Insert-only: entries cannot be changed or deleted, except
--  - the 90-day clean-up (agent_logs_prune) may delete old entries, and
--  - a link to a deleted key or request may be cleared (foreign keys "on delete set null").
-- ---------------------------------------------------------------------------
create table public.agent_logs (
  id bigint generated always as identity primary key,
  agent_id uuid not null references public.agents (id) on delete cascade,
  api_key_id uuid references public.agent_api_keys (id) on delete set null,
  client_id text,                    -- the agent's own id for the entry; sending it again is ignored
  level text not null check (level in ('debug', 'info', 'warning', 'error')),
  event text,
  message text not null,
  details jsonb,
  request_id uuid references public.action_requests (id) on delete set null,
  occurred_at timestamptz not null,  -- when the agent says it happened
  received_at timestamptz not null default now(),
  unique (agent_id, client_id)
);
create index agent_logs_agent_time on public.agent_logs (agent_id, occurred_at desc, id desc);
create index agent_logs_received on public.agent_logs (received_at);
alter table public.agent_logs enable row level security;
create policy "logs visible with agent" on public.agent_logs for select to authenticated
  using (public.can_see_agent(agent_id));
grant select on public.agent_logs to authenticated;

create function public.agent_logs_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('act.allow_log_prune', true), '') = 'on' then return old; end if;
    raise exception 'Agent log entries cannot be deleted' using errcode = 'insufficient_privilege';
  end if;
  -- UPDATE: only clearing a link to a deleted key or request.
  if (new.api_key_id is null or new.api_key_id is not distinct from old.api_key_id)
     and (new.request_id is null or new.request_id is not distinct from old.request_id)
     and (to_jsonb(new) - 'api_key_id' - 'request_id') = (to_jsonb(old) - 'api_key_id' - 'request_id') then
    return new;
  end if;
  raise exception 'Agent log entries cannot be changed' using errcode = 'insufficient_privilege';
end $$;
create trigger agent_logs_guard before update or delete on public.agent_logs
  for each row execute function public.agent_logs_guard();

-- ---------------------------------------------------------------------------
-- Being heard from. Clears the silent flag at once (audited as done by the agent).
-- ---------------------------------------------------------------------------
create function public.record_agent_contact(p_agent uuid, p_via text, p_note text default null) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  t timestamptz := clock_timestamp();
  prev_type text := current_setting('act.actor_type', true);
  prev_id text := current_setting('act.actor_id', true);
  prev_reason text := current_setting('act.reason', true);
begin
  insert into public.agent_contact as c (agent_id, last_seen_at, last_seen_via, last_note)
  values (p_agent, t, p_via, case when p_via = 'check-in' then p_note end)
  on conflict (agent_id) do update
    set last_seen_at = excluded.last_seen_at, last_seen_via = excluded.last_seen_via,
        last_note = case when excluded.last_seen_via = 'check-in' then excluded.last_note else c.last_note end;

  if exists (select 1 from public.alerts where agent_id = p_agent and kind = 'agent_silent' and resolved_at is null) then
    perform set_config('act.actor_type', 'agent', true);
    perform set_config('act.actor_id', p_agent::text, true);
    perform set_config('act.reason', 'The agent was heard from again (' || p_via || ')', true);
    update public.alerts set resolved_at = t
     where agent_id = p_agent and kind = 'agent_silent' and resolved_at is null;
    perform set_config('act.actor_type', coalesce(prev_type, ''), true);
    perform set_config('act.actor_id', coalesce(prev_id, ''), true);
    perform set_config('act.reason', coalesce(prev_reason, ''), true);
  end if;
  return t;
end $$;

-- Every call with an agent key counts (action requests, decision look-ups). agent_key_lookup is the task 2.8
-- agent_for_key plus the contact, told how the agent was heard from; agent_for_key keeps its name for its callers.
create function public.agent_key_lookup(p_agent_key text, p_via text) returns public.agents
language plpgsql security definer set search_path = '' as $$
declare
  k public.agent_api_keys;
  a public.agents;
begin
  select * into k from public.agent_api_keys
  where key_hash = public.secret_hash(coalesce(p_agent_key, '')) and revoked_at is null;
  if not found then raise exception 'Invalid or revoked agent key' using errcode = 'invalid_authorization_specification'; end if;
  update public.agent_api_keys set last_used_at = now() where id = k.id;
  perform set_config('act.api_key_id', k.id::text, true); -- read by action_requests_key (task 2.8)
  if p_via is not null then perform public.record_agent_contact(k.agent_id, p_via); end if;
  select * into a from public.agents where id = k.agent_id;
  return a;
end $$;

create or replace function public.agent_for_key(p_agent_key text) returns public.agents
language sql security definer set search_path = '' as $$
  select public.agent_key_lookup(p_agent_key, 'API call')
$$;

-- The status check (task 1.x) counts too. Same answer as before.
create or replace function public.api_agent_status(p_agent_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k public.agent_api_keys;
  a public.agents;
begin
  select * into k from public.agent_api_keys
  where key_hash = public.secret_hash(coalesce(p_agent_key, '')) and revoked_at is null;
  if not found then raise exception 'Invalid or revoked agent key' using errcode = 'invalid_authorization_specification'; end if;
  select * into a from public.agents where id = k.agent_id;
  -- Not audited: status checks are frequent reads. last_used_at and the contact time are enough evidence.
  update public.agent_api_keys set last_used_at = now() where id = k.id;
  perform public.record_agent_contact(a.id, 'status check');
  return jsonb_build_object('agent_id', a.id, 'agent_code', a.agent_code, 'status', a.status,
                            'may_act', a.status = 'live', 'autonomy_level', a.autonomy_level);
end $$;

-- The {id} in /api/v1/agents/{id}/... must be the key's own agent (its id or code), checked before anything is stored.
create function public.agent_matches_path(a public.agents, p_agent text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_agent is null or (p_agent <> a.id::text and upper(p_agent) <> a.agent_code) then
    raise exception 'This key belongs to a different agent.' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- API: check in. Answers whether the agent may act, and by when it must check in next.
-- ---------------------------------------------------------------------------
create function public.api_agent_heartbeat(p_agent_key text, p_agent text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents := public.agent_key_lookup(p_agent_key, null); -- contact recorded below, as a check-in
  note text := nullif(trim(coalesce(p_note, '')), '');
  t timestamptz;
begin
  perform public.agent_matches_path(a, p_agent);
  if length(note) > 500 then
    raise exception 'note must be 500 characters or fewer' using errcode = 'check_violation';
  end if;
  t := public.record_agent_contact(a.id, 'check-in', note);
  return jsonb_build_object('agent_id', a.id, 'agent_code', a.agent_code, 'status', a.status, 'may_act', a.status = 'live',
    'heard_at', t, 'silent_after_minutes', a.silent_after_minutes,
    'check_in_by', case when a.silent_after_minutes is not null then t + make_interval(mins => a.silent_after_minutes) end);
end $$;

-- ---------------------------------------------------------------------------
-- API: write log entries. All or nothing; up to 100 entries a call. Entries with a client id already stored
-- for this agent are skipped (safe to retry).
-- ---------------------------------------------------------------------------
create function public.api_agent_log(p_agent_key text, p_agent text, p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents := public.agent_key_lookup(p_agent_key, null); -- contact recorded at the end, as a log entry
  key_id uuid := nullif(current_setting('act.api_key_id', true), '')::uuid;
  entries jsonb := case jsonb_typeof(p_entries) when 'array' then p_entries when 'object' then jsonb_build_array(p_entries) end;
  e jsonb;
  i integer := 0;
  lvl text; msg text; ev text; cid text; ref text; req uuid; at timestamptz; det jsonb;
  added integer := 0;
  n integer;
begin
  perform public.agent_matches_path(a, p_agent);
  if entries is null or jsonb_array_length(entries) = 0 then
    raise exception 'Send at least one log entry' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(entries) > 100 then
    raise exception 'Send at most 100 log entries at a time' using errcode = 'check_violation';
  end if;

  for e in select value from jsonb_array_elements(entries) loop
    i := i + 1;
    if jsonb_typeof(e) <> 'object' then
      raise exception 'Entry %: must be a JSON object', i using errcode = 'check_violation';
    end if;
    lvl := lower(coalesce(e ->> 'level', 'info'));
    if lvl not in ('debug', 'info', 'warning', 'error') then
      raise exception 'Entry %: level must be debug, info, warning or error', i using errcode = 'check_violation';
    end if;
    msg := trim(coalesce(e ->> 'message', ''));
    if msg = '' then raise exception 'Entry %: message is required', i using errcode = 'check_violation'; end if;
    if length(msg) > 2000 then raise exception 'Entry %: message must be 2,000 characters or fewer', i using errcode = 'check_violation'; end if;
    ev := nullif(trim(coalesce(e ->> 'event', '')), '');
    if ev is not null and (length(ev) > 100 or ev !~ '^[A-Za-z0-9_.:/-]+$') then
      raise exception 'Entry %: event must be a short code (letters, digits, . _ : / -; up to 100)', i using errcode = 'check_violation';
    end if;
    cid := nullif(trim(coalesce(e ->> 'id', '')), '');
    if cid is not null and length(cid) > 100 then
      raise exception 'Entry %: id must be 100 characters or fewer', i using errcode = 'check_violation';
    end if;
    begin
      at := coalesce((e ->> 'occurred_at')::timestamptz, now());
    exception when others then
      raise exception 'Entry %: occurred_at must be a date and time such as 2026-10-28T09:15:00Z', i using errcode = 'check_violation';
    end;
    if at > now() + interval '5 minutes' or at < now() - interval '7 days' then
      raise exception 'Entry %: occurred_at must be within the last 7 days', i using errcode = 'check_violation';
    end if;
    det := e -> 'details';
    if det is not null and jsonb_typeof(det) = 'null' then det := null; end if;
    if det is not null and jsonb_typeof(det) <> 'object' then
      raise exception 'Entry %: details must be a JSON object', i using errcode = 'check_violation';
    end if;
    if det is not null and length(det::text) > 8000 then
      raise exception 'Entry %: details must be 8 KB or smaller', i using errcode = 'check_violation';
    end if;
    ref := nullif(trim(coalesce(e ->> 'request', '')), '');
    req := null;
    if ref is not null then
      select r.id into req from public.action_requests r
       where r.agent_id = a.id and (r.request_code = upper(ref) or r.id::text = lower(ref));
      if req is null then
        raise exception 'Entry %: request % is not one of this agent''s requests', i, ref using errcode = 'check_violation';
      end if;
    end if;

    insert into public.agent_logs (agent_id, api_key_id, client_id, level, event, message, details, request_id, occurred_at)
    values (a.id, key_id, cid, lvl, ev, msg, det, req, at)
    on conflict (agent_id, client_id) do nothing;
    get diagnostics n = row_count;
    added := added + n;
  end loop;

  perform public.record_agent_contact(a.id, 'log entry');
  return jsonb_build_object('agent_id', a.id, 'agent_code', a.agent_code, 'accepted', added,
                            'duplicates', jsonb_array_length(entries) - added, 'may_act', a.status = 'live');
end $$;

-- ---------------------------------------------------------------------------
-- The watch setting. Admins and the agent's owners; audited ("Details changed · silent after minutes").
-- Starting or changing it restarts the clock, so an agent is never flagged for silence before it was watched.
-- ---------------------------------------------------------------------------
create function public.set_agent_silence_limit(p_agent uuid, p_minutes integer) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.agents;
begin
  if not public.is_active_user() or not (public.has_role('admin') or public.is_agent_owner(p_agent)) then
    raise exception 'Only admins and the agent''s owners can change this' using errcode = 'insufficient_privilege';
  end if;
  select * into a from public.agents where id = p_agent;
  if not found then raise exception 'Agent not found' using errcode = 'no_data_found'; end if;
  if p_minutes is not null and (p_minutes < 1 or p_minutes > 10080) then
    raise exception 'Choose between 1 minute and 7 days' using errcode = 'check_violation';
  end if;
  if a.silent_after_minutes is not distinct from p_minutes then return; end if;
  perform public.begin_governed_change(case when p_minutes is null then 'Stopped watching for silence'
    else 'Flag if silent for more than ' || public.minutes_text(p_minutes) end);
  update public.agents set silent_after_minutes = p_minutes where id = p_agent;
  insert into public.agent_contact (agent_id, watch_from) values (p_agent, now())
  on conflict (agent_id) do update set watch_from = now();
  perform set_config('act.allow_lifecycle', '', true);
  perform set_config('act.reason', '', true);
  perform public.check_silent_agents(); -- clears a flag at once when watching stops
end $$;

-- Going live (or live again after a suspension) restarts the clock too.
create function public.agents_watch_restart() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_contact (agent_id, watch_from) values (new.id, now())
  on conflict (agent_id) do update set watch_from = now();
  return null;
end $$;
create trigger agents_watch_restart after update of status on public.agents
  for each row when (new.status = 'live' and old.status is distinct from new.status)
  execute function public.agents_watch_restart();

-- ---------------------------------------------------------------------------
-- The check, every minute. Raises the flag for live, watched agents not heard from within their limit;
-- clears it for agents heard from again, no longer watched, or no longer live. Audited as the system.
-- ---------------------------------------------------------------------------
create function public.check_silent_agents() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  raised integer;
  prev_type text := current_setting('act.actor_type', true);
  prev_reason text := current_setting('act.reason', true);
begin
  perform set_config('act.actor_type', 'system', true);

  perform set_config('act.reason', 'Silent-agent check: heard from again, no longer watched, or no longer live', true);
  update public.alerts al set resolved_at = now()
  from public.agents a
  left join public.agent_contact c on c.agent_id = a.id
  where al.agent_id = a.id and al.kind = 'agent_silent' and al.resolved_at is null
    and (a.status <> 'live' or a.silent_after_minutes is null
         or greatest(c.last_seen_at, c.watch_from) > now() - make_interval(mins => a.silent_after_minutes));

  perform set_config('act.reason', 'Silent-agent check', true);
  with new_alerts as (
    insert into public.alerts (kind, agent_id, message)
    select 'agent_silent'::public.alert_kind, a.id,
           case when c.last_seen_at is null
                then format('%s has gone silent: it has not been heard from since it started being watched (limit %s)',
                            a.agent_code, public.minutes_text(a.silent_after_minutes))
                else format('%s has gone silent: nothing heard from it for more than %s',
                            a.agent_code, public.minutes_text(a.silent_after_minutes)) end
    from public.agents a
    left join public.agent_contact c on c.agent_id = a.id
    where a.status = 'live' and a.silent_after_minutes is not null
      and coalesce(greatest(c.last_seen_at, c.watch_from), a.updated_at) <= now() - make_interval(mins => a.silent_after_minutes)
    on conflict do nothing
    returning 1)
  select count(*) into raised from new_alerts;

  perform set_config('act.actor_type', coalesce(prev_type, ''), true);
  perform set_config('act.reason', coalesce(prev_reason, ''), true);
  return raised;
end $$;

-- 90-day retention, daily.
create function public.agent_logs_prune() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform set_config('act.allow_log_prune', 'on', true);
  delete from public.agent_logs where received_at < now() - interval '90 days';
  get diagnostics n = row_count;
  perform set_config('act.allow_log_prune', '', true);
  return n;
end $$;

do $$
begin
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'silent-agents') then perform cron.unschedule('silent-agents'); end if;
    perform cron.schedule('silent-agents', '* * * * *', 'select public.check_silent_agents()');
    if exists (select 1 from cron.job where jobname = 'agent-logs-prune') then perform cron.unschedule('agent-logs-prune'); end if;
    perform cron.schedule('agent-logs-prune', '40 2 * * *', 'select public.agent_logs_prune()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Agent console (task 2.8): what the demo agent does goes into its log too, so the log has a story to show.
-- ---------------------------------------------------------------------------
create function public.demo_agent_events_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.action_requests;
begin
  select * into r from public.action_requests where id = new.request_id;
  if not found then return null; end if;
  insert into public.agent_logs (agent_id, api_key_id, level, event, message, request_id, occurred_at)
  values (r.agent_id, r.api_key_id, 'info',
          case new.kind when 'asked' then 'approval.asked' else 'approval.heard' end,
          case new.kind
            when 'asked' then 'Asked the Control Tower: ' || coalesce(r.description, r.action) || ' (answer: ' || coalesce(new.status, '?') || ')'
            else 'Heard the decision, signature checked: ' || coalesce(new.reason, new.status, '')
                 || case when new.may_proceed then '. Going ahead.' else '. Not going ahead.' end end,
          r.id, now());
  perform public.record_agent_contact(r.agent_id, 'log entry');
  return null;
end $$;
create trigger demo_agent_events_log after insert on public.demo_agent_events
  for each row execute function public.demo_agent_events_log();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on function public.agent_logs_guard(), public.record_agent_contact(uuid, text, text), public.agent_key_lookup(text, text),
  public.agent_matches_path(public.agents, text), public.api_agent_heartbeat(text, text, text), public.api_agent_log(text, text, jsonb), public.set_agent_silence_limit(uuid, integer),
  public.agents_watch_restart(), public.check_silent_agents(), public.agent_logs_prune(), public.demo_agent_events_log()
  from public, anon, authenticated;
-- The public API calls these with the publishable key (anon), like api_request_action.
grant execute on function public.api_agent_heartbeat(text, text, text), public.api_agent_log(text, text, jsonb) to anon;
grant execute on function public.set_agent_silence_limit(uuid, integer) to authenticated;
