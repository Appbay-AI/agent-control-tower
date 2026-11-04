-- Task 4.4: the incident case. An incident opens by itself when an agent is suspended, and agents or connected
-- systems can report one through the API (POST /api/v1/incidents). Every incident has an owner and a time by which
-- it should be resolved (its time limit, from its severity). The case screens (impact, containment, root cause,
-- remediation) are task 4.5; the rules (Critical incident suspends the agent, closure approver, repeats) are task 4.9.
--
-- Owner: the agent's business owner; if that person has no active account, its technical owner; then the person who
-- reported it (for a suspension, who pressed the switch); then the longest-standing active admin. The owner is told
-- on their phone unless they opened it themselves.
-- Severity: a suspension takes the agent's risk tier; a report says its own (default Medium).

create sequence public.incident_code_seq;

-- How long each severity has to be resolved, editable by admins (like the approval time limits of task 2.9).
create table public.incident_sla (
  severity public.risk_tier primary key,
  minutes integer not null check (minutes between 15 and 43200), -- 15 minutes to 30 days
  updated_at timestamptz not null default now()
);
insert into public.incident_sla (severity, minutes) values ('critical', 240), ('high', 1440), ('medium', 4320), ('low', 10080);
alter table public.incident_sla enable row level security;
create policy "incident time limits readable" on public.incident_sla for select to authenticated using (public.is_active_user());
create policy "incident time limits admin" on public.incident_sla for update to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));
revoke all on public.incident_sla from anon, authenticated;
grant select, update (minutes) on public.incident_sla to authenticated;
create trigger audit_change after update on public.incident_sla for each row execute function public.audit_table_change();

create function public.incident_sla_touch() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger incident_sla_touch before update on public.incident_sla for each row execute function public.incident_sla_touch();

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  incident_code text not null unique default ('INC-' || lpad(nextval('public.incident_code_seq')::text, 4, '0')),
  agent_id uuid not null references public.agents (id) on delete cascade,
  source text not null check (source in ('suspension', 'agent_report', 'integration_report')),
  suspension_id uuid unique references public.agent_suspensions (id) on delete set null,
  severity public.risk_tier not null,
  status text not null default 'open' check (status in ('open', 'contained', 'resolved', 'closed')),
  title text not null check (length(btrim(title)) between 1 and 200),
  description text check (length(description) <= 4000),
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  reporter text not null,                 -- who raised it, in words
  reported_by uuid references public.profiles (id),
  reporter_key_id uuid,                   -- the agent key or integration key of an API report
  idempotency_key text check (length(idempotency_key) <= 200),
  owner_id uuid references public.profiles (id),
  owner_reason text,                      -- why this person owns it
  sla_minutes integer not null,
  opened_at timestamptz not null default now(),
  occurred_at timestamptz,
  due_at timestamptz not null,
  closed_at timestamptz,
  unique (reporter_key_id, idempotency_key)
);
create index incidents_agent on public.incidents (agent_id, opened_at desc);
create index incidents_open on public.incidents (due_at) where status in ('open', 'contained');
alter table public.incidents enable row level security;
create policy "incidents visible with the agent or to their owner" on public.incidents for select to authenticated
  using (public.can_see_agent(agent_id) or owner_id = auth.uid());
revoke all on public.incidents from anon, authenticated;
grant select on public.incidents to authenticated;
create trigger audit_change after insert or update or delete on public.incidents
  for each row execute function public.audit_table_change();

alter table public.push_outbox drop constraint push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check
  check (kind in ('action_request', 'test', 'agent_discovered', 'suspension', 'enforcement', 'incident'));

-- ---------------------------------------------------------------------------
-- Open an incident (internal: called by the suspension trigger and the report API).
-- ---------------------------------------------------------------------------
create function public.incident_open(
  p_agent uuid, p_source text, p_severity public.risk_tier, p_title text, p_description text, p_details jsonb,
  p_reporter text, p_reported_by uuid default null, p_suspension uuid default null, p_key uuid default null,
  p_idempotency_key text default null, p_occurred_at timestamptz default null) returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  owner uuid;
  why text;
  mins integer;
  i public.incidents;
begin
  select * into a from public.agents where id = p_agent;
  if exists (select 1 from public.profiles where id = a.business_owner_id and is_active) then
    owner := a.business_owner_id; why := 'Business owner of the agent';
  elsif exists (select 1 from public.profiles where id = a.technical_owner_id and is_active) then
    owner := a.technical_owner_id; why := 'Technical owner of the agent (it has no active business owner)';
  elsif exists (select 1 from public.profiles where id = p_reported_by and is_active) then
    owner := p_reported_by; why := 'Raised it (the agent has no active owner)';
  else
    select p.id into owner from public.profiles p join public.user_roles r on r.user_id = p.id and r.role = 'admin'
     where p.is_active order by p.created_at, p.id limit 1;
    why := case when owner is not null then 'Admin (the agent has no active owner)' end;
  end if;

  select minutes into mins from public.incident_sla where severity = p_severity;
  mins := coalesce(mins, 1440);
  insert into public.incidents (agent_id, source, suspension_id, severity, title, description, details, reporter, reported_by,
                                reporter_key_id, idempotency_key, owner_id, owner_reason, sla_minutes, occurred_at, due_at)
  values (p_agent, p_source, p_suspension, p_severity, left(btrim(p_title), 200), nullif(btrim(coalesce(p_description, '')), ''),
          coalesce(p_details, '{}'), p_reporter, p_reported_by, p_key, p_idempotency_key, owner, why, mins, p_occurred_at,
          now() + make_interval(mins => mins))
  returning * into i;

  if owner is not null and owner is distinct from p_reported_by then
    insert into public.push_outbox (user_id, kind, title, body, url)
    values (owner, 'incident', format('Incident %s · %s', i.incident_code, a.agent_code),
            left(format('%s. %s severity; resolve by %s UTC. You own it.', rtrim(i.title, '.'), initcap(p_severity::text),
                        to_char(i.due_at at time zone 'UTC', 'DD Mon HH24:MI')), 300),
            '/agents/' || a.id);
  end if;
  return i;
end $$;

-- ---------------------------------------------------------------------------
-- Opens by itself when an agent is suspended (by the kill switch, or any other way).
-- ---------------------------------------------------------------------------
create function public.agents_suspended_incident() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  s public.agent_suspensions;
  who text;
begin
  if not (old.status = 'live' and new.status = 'suspended') then return null; end if;
  select * into s from public.agent_suspensions
   where agent_id = new.id and status = 'done' and suspended_at = now()
   order by requested_at desc limit 1;
  if found then
    select full_name into who from public.profiles where id = s.requested_by;
    if s.confirmed_by is not null then
      who := format('%s, confirmed by %s', who, (select full_name from public.profiles where id = s.confirmed_by));
    end if;
    perform public.incident_open(new.id, 'suspension', new.risk_tier, format('%s suspended: %s', new.agent_code, s.reason),
      s.reason, jsonb_build_object('suspension_id', s.id), format('%s (suspended it)', who), s.requested_by, s.id);
  else
    perform public.incident_open(new.id, 'suspension', new.risk_tier, format('%s suspended', new.agent_code),
      nullif(current_setting('act.reason', true), ''), '{}', 'The Control Tower');
  end if;
  return null;
end $$;
create trigger agents_suspended_incident after update of status on public.agents
  for each row execute function public.agents_suspended_incident();

-- ---------------------------------------------------------------------------
-- API: report an incident. POST /api/v1/incidents with an agent key (about itself) or an integration key (about any
-- agent, named in "agent"). The same idempotency key from the same key returns the first answer.
-- ---------------------------------------------------------------------------
create function public.api_report_incident(p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  ik public.integration_keys;
  key_id uuid;
  reporter text;
  src text;
  ref text := nullif(btrim(coalesce(p_payload ->> 'agent', '')), '');
  idem text := nullif(btrim(coalesce(p_payload ->> 'idempotency_key', '')), '');
  sev public.risk_tier;
  occurred timestamptz;
  i public.incidents;
  dup boolean := false;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'The request body must be a JSON object' using errcode = 'check_violation';
  end if;
  if coalesce(p_key, '') like 'act_int_%' then
    select * into ik from public.integration_keys
     where key_hash = public.secret_hash(p_key) and revoked_at is null;
    if not found then raise exception 'Invalid or revoked integration key' using errcode = 'invalid_authorization_specification'; end if;
    update public.integration_keys set last_used_at = now() where id = ik.id;
    if ref is null then
      raise exception 'Say which agent the incident is about: "agent" (its id or code, e.g. AGT-0001)' using errcode = 'check_violation';
    end if;
    select * into a from public.agents where agent_code = upper(ref) or id::text = lower(ref);
    if not found then raise exception 'No agent %', ref using errcode = 'no_data_found'; end if;
    key_id := ik.id; src := 'integration_report'; reporter := format('%s (integration, through the API)', ik.name);
    perform set_config('act.actor_type', 'integration', true);
    perform set_config('act.actor_id', ik.id::text, true);
  else
    a := public.agent_key_lookup(p_key, 'API call');
    if ref is not null then perform public.agent_matches_path(a, ref); end if;
    key_id := nullif(current_setting('act.api_key_id', true), '')::uuid;
    src := 'agent_report'; reporter := format('%s itself, through the API', a.agent_code);
    perform set_config('act.actor_type', 'agent', true);
    perform set_config('act.actor_id', a.id::text, true);
  end if;

  if idem is not null then
    if length(idem) > 200 then raise exception 'idempotency_key must be 200 characters or fewer' using errcode = 'check_violation'; end if;
    select * into i from public.incidents where reporter_key_id = key_id and idempotency_key = idem;
    dup := found;
  end if;

  if not dup then
    if length(btrim(coalesce(p_payload ->> 'title', ''))) = 0 then
      raise exception 'title is required' using errcode = 'check_violation';
    end if;
    if length(btrim(p_payload ->> 'title')) > 200 then
      raise exception 'title must be 200 characters or fewer' using errcode = 'check_violation';
    end if;
    if length(coalesce(p_payload ->> 'description', '')) > 4000 then
      raise exception 'description must be 4000 characters or fewer' using errcode = 'check_violation';
    end if;
    if p_payload ? 'severity' and lower(coalesce(p_payload ->> 'severity', '')) not in ('low', 'medium', 'high', 'critical') then
      raise exception 'severity must be low, medium, high or critical' using errcode = 'check_violation';
    end if;
    sev := coalesce(lower(p_payload ->> 'severity'), 'medium')::public.risk_tier;
    if p_payload ? 'details' and jsonb_typeof(p_payload -> 'details') <> 'object' then
      raise exception 'details must be a JSON object' using errcode = 'check_violation';
    end if;
    if octet_length(coalesce(p_payload -> 'details', '{}')::text) > 16000 then
      raise exception 'details must be 16 KB or smaller' using errcode = 'check_violation';
    end if;
    if p_payload ? 'occurred_at' then
      begin
        -- A real date and time only (Postgres would also take words such as "yesterday").
        if coalesce(p_payload ->> 'occurred_at', '') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' then raise exception 'bad'; end if;
        occurred := (p_payload ->> 'occurred_at')::timestamptz;
      exception when others then
        raise exception 'occurred_at must be a date and time, e.g. 2026-11-04T09:15:00Z' using errcode = 'check_violation';
      end;
      if occurred > now() + interval '5 minutes' then
        raise exception 'occurred_at is in the future' using errcode = 'check_violation';
      end if;
    end if;
    i := public.incident_open(a.id, src, sev, p_payload ->> 'title', p_payload ->> 'description', p_payload -> 'details',
                              reporter, null, null, key_id, idem, occurred);
  end if;

  perform set_config('act.actor_type', '', true);
  perform set_config('act.actor_id', '', true);
  return jsonb_build_object(
    'incident_id', i.id, 'incident_code', i.incident_code, 'agent_id', a.id, 'agent_code', a.agent_code,
    'status', i.status, 'severity', i.severity, 'owner', (select full_name from public.profiles where id = i.owner_id),
    'sla_minutes', i.sla_minutes, 'due_at', i.due_at, 'opened_at', i.opened_at, 'duplicate', dup);
end $$;

revoke execute on function public.incident_open(uuid, text, public.risk_tier, text, text, jsonb, text, uuid, uuid, uuid, text, timestamptz),
  public.agents_suspended_incident(), public.incident_sla_touch() from public, anon, authenticated;
revoke execute on function public.api_report_incident(text, jsonb) from public;
grant execute on function public.api_report_incident(text, jsonb) to anon, authenticated;
