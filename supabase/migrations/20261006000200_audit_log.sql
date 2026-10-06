-- Phase 1, task 1.2: insert-only, hash-chained audit log (§8: "Immutable log. Insert-only at database level.").
--
-- * Every change to a governed table is recorded automatically by a trigger.
-- * Each row carries the SHA-256 of the previous row, so any later edit breaks the chain visibly.
-- * Updates, deletes and truncates are refused by the database itself, for every role.

create table public.audit_events (
  id bigint generated always as identity primary key,
  seq bigint not null unique,
  occurred_at timestamptz not null,
  actor_id uuid,
  actor_type text not null check (actor_type in ('user', 'agent', 'integration', 'system')),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  agent_id uuid,
  summary text,
  reason text,
  before jsonb,
  after jsonb,
  prev_hash text not null,
  hash text not null unique
);

create index audit_events_agent_idx on public.audit_events (agent_id, seq desc);
create index audit_events_occurred_idx on public.audit_events (occurred_at desc);

-- Canonical text of a row for hashing. Order and format are fixed; never change this function
-- without a migration that re-anchors the chain, or verification of older rows will fail.
create function public.audit_row_digest(
  p_seq bigint, p_occurred_at timestamptz, p_actor_id uuid, p_actor_type text, p_action text,
  p_entity_type text, p_entity_id uuid, p_agent_id uuid, p_summary text, p_reason text,
  p_before jsonb, p_after jsonb, p_prev_hash text
) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(concat_ws('|',
    p_seq::text,
    to_char(p_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(p_actor_id::text, '-'), p_actor_type, p_action, p_entity_type,
    coalesce(p_entity_id::text, '-'), coalesce(p_agent_id::text, '-'),
    coalesce(p_summary, '-'), coalesce(p_reason, '-'),
    coalesce(p_before::text, '-'), coalesce(p_after::text, '-'),
    p_prev_hash
  ), 'UTF8')), 'hex')
$$;

-- Assigns sequence, timestamp and hashes. Serialised with a transaction lock so the chain has one order.
create function public.audit_events_chain() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  last_row record;
begin
  perform pg_advisory_xact_lock(hashtext('public.audit_events chain'));
  select seq, hash into last_row from public.audit_events order by seq desc limit 1;

  new.seq := coalesce(last_row.seq, 0) + 1;
  new.prev_hash := coalesce(last_row.hash, 'GENESIS');
  new.occurred_at := clock_timestamp();
  new.hash := public.audit_row_digest(
    new.seq, new.occurred_at, new.actor_id, new.actor_type, new.action, new.entity_type,
    new.entity_id, new.agent_id, new.summary, new.reason, new.before, new.after, new.prev_hash);
  return new;
end $$;

create trigger audit_events_chain before insert on public.audit_events
  for each row execute function public.audit_events_chain();

create function public.audit_events_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_events is insert-only: % is not allowed', tg_op
    using errcode = 'insufficient_privilege';
end $$;

create trigger audit_events_no_update before update or delete on public.audit_events
  for each row execute function public.audit_events_immutable();
create trigger audit_events_no_truncate before truncate on public.audit_events
  for each statement execute function public.audit_events_immutable();

-- Recomputes every hash in order. Returns the first broken row, or nothing when the chain is intact.
create function public.audit_verify_chain()
returns table (broken_seq bigint, expected_hash text, stored_hash text)
language plpgsql stable security definer set search_path = '' as $$
declare
  r record;
  prev text := 'GENESIS';
  expected_seq bigint := 1;
  calc text;
begin
  for r in select * from public.audit_events order by seq loop
    calc := public.audit_row_digest(r.seq, r.occurred_at, r.actor_id, r.actor_type, r.action, r.entity_type,
      r.entity_id, r.agent_id, r.summary, r.reason, r.before, r.after, prev);
    if r.seq <> expected_seq or r.prev_hash <> prev or r.hash <> calc then
      broken_seq := r.seq; expected_hash := calc; stored_hash := r.hash;
      return next;
      return;
    end if;
    prev := r.hash;
    expected_seq := expected_seq + 1;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Who is acting. Workflow functions set act.reason / act.actor_* for the current transaction.
-- ---------------------------------------------------------------------------
create function public.audit_actor_type() returns text
language sql stable set search_path = '' as $$
  select coalesce(
    nullif(current_setting('act.actor_type', true), ''),
    case when auth.uid() is not null then 'user' else 'system' end)
$$;

create function public.audit_actor_id() returns uuid
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('act.actor_id', true), '')::uuid, auth.uid())
$$;

-- Generic change recorder for governed tables.
create function public.audit_table_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  old_row jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) - 'key_hash' end;
  new_row jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) - 'key_hash' end;
  row_data jsonb := coalesce(new_row, old_row);
  v_agent uuid;
  v_action text;
  v_summary text;
begin
  if tg_op = 'UPDATE' then
    -- Skip no-op updates and the timestamp-only touch.
    if (old_row - 'updated_at') = (new_row - 'updated_at') then
      return null;
    end if;
  end if;

  v_agent := case when tg_table_name = 'agents' then (row_data ->> 'id')::uuid
                  else nullif(row_data ->> 'agent_id', '')::uuid end;

  v_action := tg_table_name || '.' || lower(tg_op);
  if tg_table_name = 'agents' and tg_op = 'UPDATE' and old_row ->> 'status' is distinct from new_row ->> 'status' then
    v_action := 'agents.status_changed';
    v_summary := format('%s: %s → %s', new_row ->> 'agent_code', old_row ->> 'status', new_row ->> 'status');
  elsif tg_table_name = 'agents' and tg_op = 'UPDATE'
        and old_row ->> 'autonomy_level' is distinct from new_row ->> 'autonomy_level' then
    v_action := 'agents.autonomy_changed';
    v_summary := format('%s: level %s → %s', new_row ->> 'agent_code', old_row ->> 'autonomy_level', new_row ->> 'autonomy_level');
  end if;

  insert into public.audit_events (actor_id, actor_type, action, entity_type, entity_id, agent_id, summary, reason, before, after)
  values (public.audit_actor_id(), public.audit_actor_type(), v_action, tg_table_name,
          nullif(row_data ->> 'id', '')::uuid, v_agent, v_summary,
          nullif(current_setting('act.reason', true), ''),
          case when tg_op = 'UPDATE' then old_row - 'updated_at' else old_row end,
          case when tg_op = 'UPDATE' then new_row - 'updated_at' else new_row end);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['agents', 'agent_registrations', 'registration_decisions', 'agent_reviews',
                           'alerts', 'user_roles', 'approver_scopes', 'integration_keys', 'agent_api_keys',
                           'departments', 'profiles']
  loop
    execute format('create trigger audit_change after insert or update or delete on public.%I
                    for each row execute function public.audit_table_change()', t);
  end loop;
end $$;
