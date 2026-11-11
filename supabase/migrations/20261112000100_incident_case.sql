-- Task 4.5: the incident case. Each incident gets its case fields (impact, containment, root cause, remediation), a
-- status that moves Open → Contained → Resolved (and back when reopened), severity changes and hand-overs with a
-- reason, and a log of notes and changes. People can also report an incident from the app.
-- Closing an incident is task 4.9 (closure needs a named approver), so no function here closes one.
--
-- Who may work on an incident: its owner, admins, the agent's business and technical owners, and approvers for the
-- agent's department (the same people who may suspend it, can_suspend_agent). Everyone who can see the agent can read.

create type public.incident_root_cause as enum (
  'model_error',          -- the model got it wrong (hallucination, misreading)
  'instructions',         -- prompt, instructions or configuration
  'data_quality',         -- wrong or missing input data
  'integration',          -- a connected system failed or changed
  'access',               -- permissions or access granted too widely
  'human_error',          -- a person's action or approval
  'vendor',               -- the vendor or platform
  'other'
);

alter table public.incidents
  add column impact text check (length(impact) <= 4000),
  add column customers_affected integer check (customers_affected between 0 and 100000000),
  add column financial_impact numeric(16, 2) check (financial_impact >= 0),
  add column financial_currency text check (financial_currency ~ '^[A-Z]{3}$'),
  add column personal_data text check (personal_data in ('yes', 'no', 'unknown')),
  add column containment text check (length(containment) <= 4000),
  add column contained_at timestamptz,
  add column root_cause_category public.incident_root_cause,
  add column root_cause text check (length(root_cause) <= 4000),
  add column remediation text check (length(remediation) <= 4000),
  add column resolved_at timestamptz,
  add column updated_at timestamptz not null default now();

-- The case log: notes and every change made through the functions below, newest last.
create table public.incident_updates (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  kind text not null check (kind in ('note', 'fields', 'status', 'severity', 'owner')),
  body text not null check (length(body) between 1 and 4000),
  author_id uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index incident_updates_incident on public.incident_updates (incident_id, created_at);
alter table public.incident_updates enable row level security;
create policy "incident log visible with the incident" on public.incident_updates for select to authenticated
  using (exists (select 1 from public.incidents i where i.id = incident_id and (public.can_see_agent(i.agent_id) or i.owner_id = auth.uid())));
revoke all on public.incident_updates from anon, authenticated;
grant select on public.incident_updates to authenticated;
create trigger audit_change after insert on public.incident_updates for each row execute function public.audit_table_change();

-- ---------------------------------------------------------------------------
-- Who may work on an incident
-- ---------------------------------------------------------------------------
create function public.can_work_incident(p_incident uuid, p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.incidents i join public.profiles p on p.id = p_user and p.is_active
     where i.id = p_incident and (i.owner_id = p_user or public.can_suspend_agent(i.agent_id, p_user)))
$$;

-- Locks the incident for a change by the current user, or says why not.
create function public.incident_for_change(p_incident uuid) returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare i public.incidents;
begin
  select * into i from public.incidents where id = p_incident for update;
  if not found then raise exception 'No such incident' using errcode = 'no_data_found'; end if;
  if not public.can_work_incident(p_incident) then
    raise exception 'Only the incident''s owner, admins, the agent''s owners and approvers for its department can change it'
      using errcode = 'insufficient_privilege';
  end if;
  if i.status = 'closed' then raise exception '% is closed', i.incident_code using errcode = 'check_violation'; end if;
  return i;
end $$;

create function public.incident_log(p_incident uuid, p_kind text, p_body text) returns void
language sql security definer set search_path = '' as $$
  insert into public.incident_updates (incident_id, agent_id, kind, body, author_id)
  select id, agent_id, p_kind, left(p_body, 4000), auth.uid() from public.incidents where id = p_incident
$$;

-- ---------------------------------------------------------------------------
-- Case fields. p_fields holds only the fields being changed; null or "" clears one.
-- ---------------------------------------------------------------------------
create function public.incident_save_fields(p_incident uuid, p_fields jsonb, p_note text default null) returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare
  i public.incidents;
  k text;
  allowed constant text[] := array['impact', 'customers_affected', 'financial_impact', 'financial_currency', 'personal_data',
                                   'containment', 'root_cause_category', 'root_cause', 'remediation'];
  label constant jsonb := '{"impact":"Impact","customers_affected":"Customers affected","financial_impact":"Money involved",
    "financial_currency":"Currency","personal_data":"Personal data involved","containment":"Containment",
    "root_cause_category":"Root cause category","root_cause":"Root cause","remediation":"Remediation"}';
  changed text[] := '{}';
  v text;
begin
  i := public.incident_for_change(p_incident);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'Send the fields to change as an object' using errcode = 'check_violation';
  end if;
  for k in select jsonb_object_keys(p_fields) loop
    if not k = any (allowed) then raise exception 'Unknown field %', k using errcode = 'check_violation'; end if;
  end loop;

  perform set_config('act.reason', coalesce(nullif(btrim(p_note), ''), 'Incident case updated'), true);
  for k in select unnest(allowed) loop
    continue when not p_fields ? k;
    v := nullif(btrim(coalesce(p_fields ->> k, '')), '');
    begin
      case k
        when 'impact' then if i.impact is distinct from v then i.impact := v; changed := changed || k; end if;
        when 'containment' then if i.containment is distinct from v then i.containment := v; changed := changed || k; end if;
        when 'root_cause' then if i.root_cause is distinct from v then i.root_cause := v; changed := changed || k; end if;
        when 'remediation' then if i.remediation is distinct from v then i.remediation := v; changed := changed || k; end if;
        when 'customers_affected' then
          if i.customers_affected is distinct from v::integer then i.customers_affected := v::integer; changed := changed || k; end if;
        when 'financial_impact' then
          if i.financial_impact is distinct from v::numeric then i.financial_impact := v::numeric; changed := changed || k; end if;
        when 'financial_currency' then
          if i.financial_currency is distinct from upper(v) then i.financial_currency := upper(v); changed := changed || k; end if;
        when 'personal_data' then
          if i.personal_data is distinct from lower(v) then i.personal_data := lower(v); changed := changed || k; end if;
        when 'root_cause_category' then
          if i.root_cause_category is distinct from v::public.incident_root_cause then
            i.root_cause_category := v::public.incident_root_cause; changed := changed || k;
          end if;
      end case;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception '% is not valid: %', label ->> k, v using errcode = 'check_violation';
    end;
  end loop;
  if i.customers_affected < 0 or i.financial_impact < 0 then
    raise exception 'Customers affected and money involved cannot be negative' using errcode = 'check_violation';
  end if;
  if i.personal_data not in ('yes', 'no', 'unknown') then
    raise exception 'Personal data involved must be yes, no or unknown' using errcode = 'check_violation';
  end if;
  if i.financial_currency !~ '^[A-Z]{3}$' then
    raise exception 'Currency must be a three-letter code such as GBP' using errcode = 'check_violation';
  end if;
  if length(i.impact) > 4000 or length(i.containment) > 4000 or length(i.root_cause) > 4000 or length(i.remediation) > 4000 then
    raise exception 'Each text must be 4000 characters or fewer' using errcode = 'check_violation';
  end if;
  if i.financial_impact is not null and i.financial_currency is null then
    i.financial_currency := (select threshold_currency from public.agents where id = i.agent_id);
  end if;

  if cardinality(changed) > 0 then
    update public.incidents set impact = i.impact, customers_affected = i.customers_affected, financial_impact = i.financial_impact,
           financial_currency = i.financial_currency, personal_data = i.personal_data, containment = i.containment,
           root_cause_category = i.root_cause_category, root_cause = i.root_cause, remediation = i.remediation, updated_at = now()
     where id = i.id
    returning * into i;
    perform public.incident_log(i.id, 'fields', format('Updated %s%s',
      (select string_agg(label ->> c, ', ') from unnest(changed) c),
      coalesce(': ' || nullif(btrim(p_note), ''), '')));
  end if;
  perform set_config('act.reason', '', true);
  return i;
end $$;

-- What is still missing before an incident can move to `p_status` (empty when nothing is).
create function public.incident_missing(i public.incidents, p_status text) returns text[]
language sql immutable set search_path = '' as $$
  select array_remove(array[
    case when p_status in ('contained', 'resolved') and i.containment is null then 'containment' end,
    case when p_status = 'resolved' and i.impact is null then 'impact' end,
    case when p_status = 'resolved' and i.personal_data is null then 'whether personal data was involved' end,
    case when p_status = 'resolved' and i.root_cause_category is null then 'root cause category' end,
    case when p_status = 'resolved' and i.root_cause is null then 'root cause' end,
    case when p_status = 'resolved' and i.remediation is null then 'remediation' end
  ], null)
$$;

-- ---------------------------------------------------------------------------
-- Status: open → contained → resolved; reopen (resolved → open or contained) needs a reason.
-- ---------------------------------------------------------------------------
create function public.incident_set_status(p_incident uuid, p_status text, p_note text default null) returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare
  i public.incidents;
  missing text[];
  note text := nullif(btrim(coalesce(p_note, '')), '');
  label constant jsonb := '{"open":"Open","contained":"Contained","resolved":"Resolved"}';
begin
  i := public.incident_for_change(p_incident);
  if p_status = 'closed' then
    raise exception 'Closing needs a named approver (coming with task 4.9)' using errcode = 'check_violation';
  end if;
  if p_status not in ('open', 'contained', 'resolved') then
    raise exception 'Unknown status %', p_status using errcode = 'check_violation';
  end if;
  if p_status = i.status then return i; end if;
  if i.status = 'resolved' and note is null then
    raise exception 'Say why it is reopened' using errcode = 'check_violation';
  end if;
  if i.status = 'contained' and p_status = 'open' and note is null then
    raise exception 'Say why it is no longer contained' using errcode = 'check_violation';
  end if;
  missing := public.incident_missing(i, p_status);
  if cardinality(missing) > 0 then
    raise exception 'Before marking it %, fill in: %', lower(label ->> p_status), array_to_string(missing, ', ')
      using errcode = 'check_violation';
  end if;

  perform set_config('act.reason', coalesce(note, format('Marked %s', lower(label ->> p_status))), true);
  update public.incidents set status = p_status, updated_at = now(),
         contained_at = case when p_status in ('contained', 'resolved') then coalesce(contained_at, now()) else null end,
         resolved_at = case when p_status = 'resolved' then now() else null end
   where id = i.id returning * into i;
  perform public.incident_log(i.id, 'status', format('%s%s', label ->> p_status, coalesce(': ' || note, '')));
  perform set_config('act.reason', '', true);
  return i;
end $$;

-- ---------------------------------------------------------------------------
-- Severity (with a reason): the time to resolve follows, counted from when it opened.
-- ---------------------------------------------------------------------------
create function public.incident_set_severity(p_incident uuid, p_severity public.risk_tier, p_reason text) returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare
  i public.incidents;
  mins integer;
  before public.risk_tier;
begin
  i := public.incident_for_change(p_incident);
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'Say why the severity changes' using errcode = 'check_violation'; end if;
  if p_severity = i.severity then return i; end if;
  before := i.severity;
  select minutes into mins from public.incident_sla where severity = p_severity;
  perform set_config('act.reason', btrim(p_reason), true);
  update public.incidents set severity = p_severity, sla_minutes = coalesce(mins, sla_minutes),
         due_at = opened_at + make_interval(mins => coalesce(mins, sla_minutes)), updated_at = now()
   where id = i.id returning * into i;
  perform public.incident_log(i.id, 'severity', format('Severity %s → %s: %s', initcap(before::text), initcap(p_severity::text), btrim(p_reason)));
  perform set_config('act.reason', '', true);
  return i;
end $$;

-- ---------------------------------------------------------------------------
-- Hand over to another active person (with a reason); the new owner is told on their phone.
-- ---------------------------------------------------------------------------
create function public.incident_reassign(p_incident uuid, p_owner uuid, p_reason text) returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare
  i public.incidents;
  who text;
  code text;
begin
  i := public.incident_for_change(p_incident);
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'Say why it is handed over' using errcode = 'check_violation'; end if;
  select full_name into who from public.profiles where id = p_owner and is_active;
  if who is null then raise exception 'The new owner must be an active user' using errcode = 'check_violation'; end if;
  if p_owner = i.owner_id then return i; end if;
  perform set_config('act.reason', btrim(p_reason), true);
  update public.incidents set owner_id = p_owner, owner_reason = format('Handed over by %s', (select full_name from public.profiles where id = auth.uid())),
         updated_at = now()
   where id = i.id returning * into i;
  perform public.incident_log(i.id, 'owner', format('Handed over to %s: %s', who, btrim(p_reason)));
  perform set_config('act.reason', '', true);
  if p_owner <> auth.uid() then
    select agent_code into code from public.agents where id = i.agent_id;
    insert into public.push_outbox (user_id, kind, title, body, url)
    values (p_owner, 'incident', format('Incident %s · %s', i.incident_code, code),
            left(format('Handed to you: %s. Resolve by %s UTC.', rtrim(i.title, '.'), to_char(i.due_at at time zone 'UTC', 'DD Mon HH24:MI')), 300),
            '/incidents/' || i.id);
  end if;
  return i;
end $$;

create function public.incident_add_note(p_incident uuid, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.incident_for_change(p_incident);
  if length(btrim(coalesce(p_body, ''))) = 0 then raise exception 'Write the note first' using errcode = 'check_violation'; end if;
  perform public.incident_log(p_incident, 'note', btrim(p_body));
  update public.incidents set updated_at = now() where id = p_incident;
end $$;

-- ---------------------------------------------------------------------------
-- Report an incident from the app (the people who may suspend the agent).
-- ---------------------------------------------------------------------------
create function public.report_incident(p_agent uuid, p_title text, p_severity public.risk_tier, p_description text default null)
returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare
  who text;
  i public.incidents;
begin
  if not public.can_suspend_agent(p_agent) then
    raise exception 'Only admins, the agent''s owners and approvers for its department can report an incident on it'
      using errcode = 'insufficient_privilege';
  end if;
  if length(btrim(coalesce(p_title, ''))) = 0 then raise exception 'Give the incident a title' using errcode = 'check_violation'; end if;
  if length(btrim(p_title)) > 200 then raise exception 'The title must be 200 characters or fewer' using errcode = 'check_violation'; end if;
  if length(coalesce(p_description, '')) > 4000 then raise exception 'The description must be 4000 characters or fewer' using errcode = 'check_violation'; end if;
  select full_name into who from public.profiles where id = auth.uid();
  i := public.incident_open(p_agent, 'user_report', coalesce(p_severity, 'medium'), p_title, p_description, '{}',
                            format('%s (reported in Control Tower)', who), auth.uid());
  return i;
end $$;

alter table public.incidents drop constraint incidents_source_check;
alter table public.incidents add constraint incidents_source_check
  check (source in ('suspension', 'agent_report', 'integration_report', 'user_report'));

revoke execute on function public.incident_for_change(uuid), public.incident_log(uuid, text, text),
  public.incident_missing(public.incidents, text) from public, anon, authenticated;
revoke execute on function public.can_work_incident(uuid, uuid), public.incident_save_fields(uuid, jsonb, text),
  public.incident_set_status(uuid, text, text), public.incident_set_severity(uuid, public.risk_tier, text),
  public.incident_reassign(uuid, uuid, text), public.incident_add_note(uuid, text),
  public.report_incident(uuid, text, public.risk_tier, text) from public, anon;
grant execute on function public.can_work_incident(uuid, uuid), public.incident_save_fields(uuid, jsonb, text),
  public.incident_set_status(uuid, text, text), public.incident_set_severity(uuid, public.risk_tier, text),
  public.incident_reassign(uuid, uuid, text), public.incident_add_note(uuid, text),
  public.report_incident(uuid, text, public.risk_tier, text) to authenticated;
