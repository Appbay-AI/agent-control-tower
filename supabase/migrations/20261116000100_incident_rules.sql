-- Task 4.9: the incident rules and drift records (R3.6, R3.7).
--   1. A Critical incident suspends its agent at once (when it opens, or when an incident is raised to Critical).
--   2. Closing an incident needs a named approver: the person working it names an admin or an approver for the agent's
--      department (not themselves); only that person can close it, or turn the closure down.
--   3. Repeats force a review: a second incident with the same root cause within 90 days, any 3 incidents within 90
--      days, or the agent switched back on outside Control Tower 3 times within 90 days. The review is due at once, an
--      alert stays open until a review is recorded, and the agent cannot be asked back on until then.
--   4. Every drift (a change made outside Control Tower that the platform shows) is recorded with what was expected,
--      what was observed, who did it ("Unknown, outside Control Tower" unless the platform says), what Control Tower did,
--      and the result.

alter type public.alert_kind add value if not exists 'review_required';

alter table public.push_outbox drop constraint push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check
  check (kind in ('action_request', 'test', 'agent_discovered', 'suspension', 'enforcement', 'incident', 'reactivation',
                  'reconciliation', 'data_authority', 'incident_closure', 'review_required'));

-- ===========================================================================
-- 1. A Critical incident suspends its agent
-- ===========================================================================
alter table public.agent_suspensions alter column requested_by drop not null;  -- null = Control Tower itself (a rule)
alter table public.agent_suspensions add column incident_id uuid references public.incidents (id) on delete set null;

create function public.incident_critical_suspend() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  s_id uuid;
  was_allow text := coalesce(current_setting('act.allow_lifecycle', true), '');
  was_reason text := coalesce(current_setting('act.reason', true), '');
  was_actor text := coalesce(current_setting('act.actor_type', true), '');
begin
  if new.severity <> 'critical' or new.status not in ('open', 'contained') then return null; end if;
  if tg_op = 'UPDATE' and old.severity = 'critical' then return null; end if;
  select * into a from public.agents where id = new.agent_id for update;
  if a.status <> 'live' then return null; end if;

  insert into public.agent_suspensions (agent_id, status, reason, requested_by, incident_id, suspended_at)
  values (a.id, 'done', left(format('Critical incident %s: %s', new.incident_code, new.title), 2000), null, new.id, now())
  returning id into s_id;
  perform public.begin_governed_change(format('Suspended automatically: Critical incident %s', new.incident_code));
  perform set_config('act.actor_type', 'system', true);
  update public.agents set status = 'suspended' where id = a.id;
  perform set_config('act.actor_type', was_actor, true);
  perform set_config('act.allow_lifecycle', was_allow, true);
  perform set_config('act.reason', was_reason, true);
  insert into public.incident_updates (incident_id, agent_id, kind, body, author_id)
  values (new.id, a.id, 'status', format('%s suspended automatically: the incident is Critical', a.agent_code), null);
  return null;
end $$;
create trigger incident_critical_suspend after insert or update of severity on public.incidents
  for each row execute function public.incident_critical_suspend();

-- A suspension made by a Critical incident does not open a second incident.
create or replace function public.agents_suspended_incident() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  s public.agent_suspensions;
  who text;
begin
  if not (old.status = 'live' and new.status = 'suspended') then return null; end if;
  select * into s from public.agent_suspensions
   where agent_id = new.id and status = 'done' and suspended_at = now()
   order by requested_at desc limit 1;
  if found and s.incident_id is not null then return null; end if;
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

-- ===========================================================================
-- 2. Closing needs a named approver
-- ===========================================================================
alter table public.incidents
  add column closure_approver_id uuid references public.profiles (id),
  add column closure_requested_by uuid references public.profiles (id),
  add column closure_requested_at timestamptz,
  add column closure_note text check (length(closure_note) <= 2000),
  add column closed_by uuid references public.profiles (id);

-- Who may be named: an active admin, or an active approver for the agent's department.
create function public.can_close_incident(p_incident uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.incidents i join public.agents a on a.id = i.agent_id join public.profiles p on p.id = p_user and p.is_active
     where i.id = p_incident
       and (exists (select 1 from public.user_roles r where r.user_id = p_user and r.role = 'admin')
            or (exists (select 1 from public.user_roles r where r.user_id = p_user and r.role = 'approver')
                and exists (select 1 from public.approver_scopes s where s.user_id = p_user and s.department_id = a.department_id))))
$$;

-- The people who may be named for one incident (for the screen), never the asker.
create function public.incident_closure_approvers(p_incident uuid) returns table (id uuid, full_name text, job_title text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, p.job_title from public.profiles p
   where p.is_active and p.id <> auth.uid() and public.can_close_incident(p_incident, p.id)
     and public.can_work_incident(p_incident)
   order by p.full_name
$$;

create function public.request_incident_closure(p_incident uuid, p_approver uuid, p_note text default null) returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare
  i public.incidents;
  who text;
  code text;
begin
  i := public.incident_for_change(p_incident);
  if i.status <> 'resolved' then
    raise exception 'Only a resolved incident can be closed (it is %)', i.status using errcode = 'check_violation';
  end if;
  if p_approver is null or p_approver = auth.uid() then
    raise exception 'Name someone else to approve the closure' using errcode = 'check_violation';
  end if;
  if not public.can_close_incident(p_incident, p_approver) then
    raise exception 'The approver must be an admin or an approver for the agent''s department' using errcode = 'check_violation';
  end if;
  select full_name into who from public.profiles where id = p_approver;
  update public.incidents set closure_approver_id = p_approver, closure_requested_by = auth.uid(), closure_requested_at = now(),
         closure_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
   where id = i.id returning * into i;
  perform public.incident_log(i.id, 'status', format('Closure asked of %s%s', who, coalesce(': ' || i.closure_note, '')));
  select agent_code into code from public.agents where id = i.agent_id;
  insert into public.push_outbox (user_id, kind, title, body, url)
  values (p_approver, 'incident_closure', format('Close %s? · %s', i.incident_code, code),
          left(format('%s asks you to approve closing: %s', (select full_name from public.profiles where id = auth.uid()), i.title), 300),
          '/incidents/' || i.id);
  return i;
end $$;

create function public.decide_incident_closure(p_incident uuid, p_approve boolean, p_note text default null) returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare
  i public.incidents;
  me text;
  note text := nullif(btrim(coalesce(p_note, '')), '');
  code text;
begin
  select * into i from public.incidents where id = p_incident for update;
  if not found then raise exception 'No such incident' using errcode = 'no_data_found'; end if;
  if i.closure_approver_id is null or i.status <> 'resolved' then
    raise exception 'No closure is waiting for approval on %', i.incident_code using errcode = 'check_violation';
  end if;
  if i.closure_approver_id <> auth.uid() then
    raise exception 'Only % can decide this closure', (select full_name from public.profiles where id = i.closure_approver_id)
      using errcode = 'insufficient_privilege';
  end if;
  if not p_approve and note is null then raise exception 'Say why it is not closed' using errcode = 'check_violation'; end if;
  select full_name into me from public.profiles where id = auth.uid();
  perform set_config('act.reason', coalesce(note, case when p_approve then 'Closure approved' else 'Closure turned down' end), true);
  if p_approve then
    update public.incidents set status = 'closed', closed_at = now(), closed_by = auth.uid(), updated_at = now()
     where id = i.id returning * into i;
    perform public.incident_log(i.id, 'status', format('Closed: approved by %s%s', me, coalesce(': ' || note, '')));
  else
    update public.incidents set closure_approver_id = null, closure_requested_at = null, updated_at = now()
     where id = i.id returning * into i;
    perform public.incident_log(i.id, 'status', format('Closure turned down by %s: %s', me, note));
  end if;
  perform set_config('act.reason', '', true);
  select agent_code into code from public.agents where id = i.agent_id;
  if i.closure_requested_by is not null and i.closure_requested_by <> auth.uid() then
    insert into public.push_outbox (user_id, kind, title, body, url)
    values (i.closure_requested_by, 'incident_closure',
            format('%s %s · %s', case when p_approve then 'Closed' else 'Not closed' end, i.incident_code, code),
            left(format('%s %s the closure%s', me, case when p_approve then 'approved' else 'turned down' end, coalesce(': ' || note, '.')), 300),
            '/incidents/' || i.id);
  end if;
  return i;
end $$;

-- Reopening clears a closure that was waiting; the old "closed" refusal now points to the named approver.
create or replace function public.incident_set_status(p_incident uuid, p_status text, p_note text default null) returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare
  i public.incidents;
  missing text[];
  note text := nullif(btrim(coalesce(p_note, '')), '');
  label constant jsonb := '{"open":"Open","contained":"Contained","resolved":"Resolved"}';
begin
  i := public.incident_for_change(p_incident);
  if p_status = 'closed' then
    raise exception 'Closing needs a named approver: ask one with Close' using errcode = 'check_violation';
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
         resolved_at = case when p_status = 'resolved' then now() else null end,
         closure_approver_id = null, closure_requested_by = null, closure_requested_at = null, closure_note = null
   where id = i.id returning * into i;
  perform public.incident_log(i.id, 'status', format('%s%s', label ->> p_status, coalesce(': ' || note, '')));
  perform set_config('act.reason', '', true);
  return i;
end $$;

-- ===========================================================================
-- 3. Repeats force a review
-- ===========================================================================
alter table public.agents
  add column review_required_reason text,
  add column review_required_at timestamptz;

create function public.force_review(p_agent uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  was_allow text := coalesce(current_setting('act.allow_lifecycle', true), '');
  was_reason text := coalesce(current_setting('act.reason', true), '');
  was_actor text := coalesce(current_setting('act.actor_type', true), '');
begin
  select * into a from public.agents where id = p_agent for update;
  if not found or a.status = 'retired' or a.review_required_at is not null then return; end if;
  perform public.begin_governed_change(format('Review required: %s', p_reason));
  perform set_config('act.actor_type', 'system', true);
  update public.agents set review_required_reason = left(p_reason, 1000), review_required_at = now(),
         next_review_date = least(coalesce(next_review_date, current_date), current_date)
   where id = a.id;
  perform set_config('act.actor_type', was_actor, true);
  perform set_config('act.allow_lifecycle', was_allow, true);
  perform set_config('act.reason', was_reason, true);
  insert into public.alerts (kind, agent_id, message)
  values ('review_required', a.id, left(format('%s must be reviewed now: %s. It cannot be asked back on until a review is recorded.', a.agent_code, p_reason), 1000))
  on conflict do nothing;
  insert into public.push_outbox (user_id, kind, title, body, url)
  select p.id, 'review_required', format('Review required · %s', a.agent_code), left(p_reason, 300), '/agents/' || a.id
    from public.profiles p
   where p.is_active and (p.id = a.business_owner_id or exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin'));
end $$;

-- Looks at the agent's last 90 days of incidents after each new incident (and after a root cause is set).
create function public.incident_repeat_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  outside text;
  all3 text;
  same text;
begin
  if tg_op = 'UPDATE' and new.root_cause_category is not distinct from old.root_cause_category then return null; end if;
  select string_agg(incident_code, ', ' order by opened_at) into outside from (
    select incident_code, opened_at from public.incidents
     where agent_id = new.agent_id and source = 'reconciliation' and opened_at > now() - interval '90 days') x
   having count(*) >= 3;
  if outside is not null then
    perform public.force_review(new.agent_id, format('switched back on outside Control Tower 3 times in 90 days (%s)', outside));
    return null;
  end if;
  if new.root_cause_category is not null then
    select string_agg(incident_code, ', ' order by opened_at) into same from public.incidents
     where agent_id = new.agent_id and root_cause_category = new.root_cause_category and opened_at > now() - interval '90 days'
    having count(*) >= 2;
    if same is not null then
      perform public.force_review(new.agent_id, format('the same root cause twice in 90 days (%s: %s)',
        replace(initcap(new.root_cause_category::text), '_', ' '), same));
      return null;
    end if;
  end if;
  select string_agg(incident_code, ', ' order by opened_at) into all3 from public.incidents
   where agent_id = new.agent_id and opened_at > now() - interval '90 days'
  having count(*) >= 3;
  if all3 is not null then
    perform public.force_review(new.agent_id, format('3 incidents in 90 days (%s)', all3));
  end if;
  return null;
end $$;
create trigger incident_repeat_check after insert or update of root_cause_category on public.incidents
  for each row execute function public.incident_repeat_check();

-- A recorded review settles it.
create function public.agent_review_settles() returns trigger
language plpgsql security definer set search_path = '' as $$
declare was_allow text := coalesce(current_setting('act.allow_lifecycle', true), '');
begin
  if exists (select 1 from public.agents where id = new.agent_id and review_required_at is not null) then
    perform set_config('act.allow_lifecycle', 'on', true);
    update public.agents set review_required_reason = null, review_required_at = null where id = new.agent_id;
    perform set_config('act.allow_lifecycle', was_allow, true);
  end if;
  update public.alerts set resolved_at = now() where agent_id = new.agent_id and kind = 'review_required' and resolved_at is null;
  return null;
end $$;
create trigger agent_review_settles after insert on public.agent_reviews
  for each row execute function public.agent_review_settles();

-- Asking for an agent back on waits for a required review.
create or replace function public.request_reactivation(p_agent uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  open_codes text;
  r_id uuid;
  who text;
begin
  select * into a from public.agents where id = p_agent for update;
  if not found then raise exception 'No such agent' using errcode = 'no_data_found'; end if;
  if not public.can_suspend_agent(p_agent) then
    raise exception 'Only admins, the agent''s owners and approvers for its department can ask to switch it back on'
      using errcode = 'insufficient_privilege';
  end if;
  if a.status <> 'suspended' then
    raise exception '% is %, not suspended', a.agent_code, a.status using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Say why it is safe to switch it back on' using errcode = 'check_violation';
  end if;
  if length(btrim(p_reason)) > 1000 then raise exception 'The reason must be 1000 characters or fewer' using errcode = 'check_violation'; end if;
  if a.review_required_at is not null then
    raise exception 'Record the required review first (%)', a.review_required_reason using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.agent_reactivations where agent_id = p_agent and status = 'pending') then
    raise exception 'A request to switch % back on is already waiting', a.agent_code using errcode = 'unique_violation';
  end if;
  select string_agg(incident_code, ', ' order by incident_code) into open_codes
    from public.incidents where agent_id = p_agent and status = 'open';
  if open_codes is not null then
    raise exception 'Contain the open incident first (%): an agent goes back on only once every incident is at least Contained', open_codes
      using errcode = 'check_violation';
  end if;

  insert into public.agent_reactivations (agent_id, suspension_id, reason, requested_by, required_approvals)
  values (p_agent,
          (select id from public.agent_suspensions where agent_id = p_agent and status = 'done' order by suspended_at desc nulls last limit 1),
          btrim(p_reason), auth.uid(), case when a.risk_tier = 'critical' then 2 else 1 end)
  returning id into r_id;

  select full_name into who from public.profiles where id = auth.uid();
  insert into public.push_outbox (user_id, kind, title, body, url)
  select p.id, 'reactivation', format('Switch back on? · %s', a.agent_code),
         left(format('%s asks to switch %s back on: %s', who, a.name, btrim(p_reason)), 300), '/agents/' || a.id
    from public.profiles p
   where p.is_active and p.id <> auth.uid() and public.can_approve_reactivation(p_agent, p.id);
  return r_id;
end $$;

-- ===========================================================================
-- 4. Drift records
-- ===========================================================================
create table public.drift_events (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  platform_agent_id uuid references public.platform_agents (id) on delete set null,
  kind text not null check (kind in ('switched_on_outside', 'blocked_outside', 'owner_changed', 'sharing_changed', 'capabilities_changed')),
  expected text not null,
  observed text not null,
  actor text not null default 'Unknown, outside Control Tower',
  action text not null,
  result text not null,
  incident_id uuid references public.incidents (id) on delete set null,
  enforcement_id bigint references public.agent_enforcements (id) on delete set null,
  detected_at timestamptz not null default now()
);
create index drift_events_agent on public.drift_events (agent_id, detected_at desc);
create index drift_events_detected on public.drift_events (detected_at desc);
alter table public.drift_events enable row level security;
create policy "drift visible with the agent" on public.drift_events for select to authenticated using (public.can_see_agent(agent_id));
revoke all on public.drift_events from anon, authenticated;
grant select on public.drift_events to authenticated;
create trigger audit_change after insert on public.drift_events for each row execute function public.audit_table_change();

-- Who did it: the platform's own record when it has one (not our service account), else unknown.
create function public.drift_actor(p_by text, p_platform text) returns text
language sql immutable set search_path = '' as $$
  select case when coalesce(btrim(p_by), '') = '' or p_by = 'act-integration' then 'Unknown, outside Control Tower'
              else format('%s on %s (outside Control Tower)', p_by, p_platform) end
$$;

create function public.people_text(p jsonb) returns text
language sql immutable set search_path = '' as $$
  select coalesce(string_agg(format('%s (%s)', coalesce(x ->> 'name', x ->> 'email'), coalesce(nullif(x ->> 'jobTitle', ''), 'role not known')), ', '
                             order by x ->> 'email'), 'nobody')
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]' end) x
$$;

create function public.list_text(p jsonb) returns text
language sql immutable set search_path = '' as $$
  select coalesce(string_agg(x, ', ' order by x), 'none')
    from jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]' end) x
$$;

-- Owner, sharing, tools and data kinds on the platform (replaces the 4.8 trigger: it still records the change on the
-- audit trail and checks data authority, and now also writes the drift record).
create or replace function public.platform_agents_sharing_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  added text;
  removed text;
  owner_before text;
  owner_after text;
  code text;
  conn text;
  without text;
  caps_before text;
  caps_after text;
begin
  if new.agent_id is null then return null; end if;
  if tg_op = 'UPDATE' and new.agent_id is not distinct from old.agent_id
     and new.details -> 'sharedWith' is not distinct from old.details -> 'sharedWith'
     and new.details -> 'owner' is not distinct from old.details -> 'owner'
     and new.details -> 'tools' is not distinct from old.details -> 'tools'
     and new.details -> 'dataSources' is not distinct from old.details -> 'dataSources'
     and new.details -> 'dataClassifications' is not distinct from old.details -> 'dataClassifications'
     and new.missing_since is not distinct from old.missing_since then
    return null;
  end if;
  perform public.authority_recheck(new.agent_id);
  if tg_op = 'UPDATE' and old.agent_id is not null and old.agent_id is distinct from new.agent_id then
    perform public.authority_recheck(old.agent_id);
  end if;
  if not (tg_op = 'UPDATE' and new.agent_id is not distinct from old.agent_id) then return null; end if;

  select agent_code into code from public.agents where id = new.agent_id;
  select name into conn from public.platform_connections where id = new.connection_id;
  select string_agg(format('%s (%s)', coalesce(g.name, g.email), coalesce(g.job_title, 'role not known')), ', ')
    into without from public.agent_authority_findings g where g.agent_id = new.agent_id;

  -- Sharing
  select string_agg(format('%s (%s)', coalesce(s ->> 'name', s ->> 'email'), coalesce(s ->> 'jobTitle', 'role not known')), ', ')
    into added from jsonb_array_elements(coalesce(new.details -> 'sharedWith', '[]')) s
   where not exists (select 1 from jsonb_array_elements(coalesce(old.details -> 'sharedWith', '[]')) o where lower(o ->> 'email') = lower(s ->> 'email'));
  select string_agg(coalesce(s ->> 'name', s ->> 'email'), ', ')
    into removed from jsonb_array_elements(coalesce(old.details -> 'sharedWith', '[]')) s
   where not exists (select 1 from jsonb_array_elements(coalesce(new.details -> 'sharedWith', '[]')) o where lower(o ->> 'email') = lower(s ->> 'email'));
  owner_before := coalesce(old.details -> 'owner' ->> 'name', old.details -> 'owner' ->> 'email', 'nobody');
  owner_after := coalesce(new.details -> 'owner' ->> 'name', new.details -> 'owner' ->> 'email', 'nobody');
  if added is not null or removed is not null or owner_before <> owner_after then
    insert into public.audit_events (actor_id, actor_type, action, entity_type, entity_id, agent_id, summary, reason)
    values (null, 'system', 'platform_agents.sharing_changed', 'platform_agents', new.id, new.agent_id,
            left(concat_ws('; ', format('%s on %s as %s', code, conn, new.external_id),
                           case when owner_before <> owner_after then format('owner %s → %s', owner_before, owner_after) end,
                           case when added is not null then 'shared with ' || added end,
                           case when removed is not null then 'no longer shared with ' || removed end)
                 || '. Changed outside Control Tower (actor unknown).', 1000),
            'Platform sync');
  end if;
  if owner_before <> owner_after then
    insert into public.drift_events (agent_id, platform_agent_id, kind, expected, observed, action, result)
    values (new.agent_id, new.id, 'owner_changed', format('Owner on %s: %s', conn, owner_before), format('Owner on %s: %s', conn, owner_after),
            'Recorded; everyone with access checked against the data-authority matrix',
            coalesce('Without authority: ' || without || '. Alert raised', 'Everyone with access is authorised'));
  end if;
  if added is not null or removed is not null then
    insert into public.drift_events (agent_id, platform_agent_id, kind, expected, observed, action, result)
    values (new.agent_id, new.id, 'sharing_changed',
            format('Shared with %s', public.people_text(old.details -> 'sharedWith')),
            format('Shared with %s', public.people_text(new.details -> 'sharedWith')),
            'Recorded; everyone with access checked against the data-authority matrix',
            coalesce('Without authority: ' || without || '. Alert raised', 'Everyone with access is authorised'));
  end if;

  -- Tools, data sources and data kinds (the registry takes them from the platform, task 3.6)
  caps_before := format('Tools: %s. Data sources: %s. Data: %s', public.list_text(old.details -> 'tools'),
                        public.list_text(old.details -> 'dataSources'), initcap(public.list_text(old.details -> 'dataClassifications')));
  caps_after := format('Tools: %s. Data sources: %s. Data: %s', public.list_text(new.details -> 'tools'),
                       public.list_text(new.details -> 'dataSources'), initcap(public.list_text(new.details -> 'dataClassifications')));
  if caps_before <> caps_after then
    insert into public.drift_events (agent_id, platform_agent_id, kind, expected, observed, action, result)
    values (new.agent_id, new.id, 'capabilities_changed', caps_before, caps_after,
            'Registry updated from the platform; data authority checked again',
            coalesce('Without authority: ' || without || '. Alert raised', 'Registry updated; everyone with access is authorised'));
  end if;
  return null;
end $$;

-- A Live agent blocked on its platform by someone else (not a Control Tower stop).
create function public.platform_agents_status_drift() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  conn text;
begin
  if new.agent_id is null or new.status is not distinct from old.status or new.status <> 'blocked' then return null; end if;
  select * into a from public.agents where id = new.agent_id;
  if a.status <> 'live' then return null; end if;
  -- Our own stop steps (and an unfinished restore) are not drift.
  if exists (select 1 from public.agent_enforcements e where e.platform_agent_id = new.id
              and ((e.action = 'stop' and e.created_at > now() - interval '1 hour') or (e.action = 'restore' and e.status = 'pending'))) then
    return null;
  end if;
  select name into conn from public.platform_connections where id = new.connection_id;
  insert into public.drift_events (agent_id, platform_agent_id, kind, expected, observed, actor, action, result)
  values (a.id, new.id, 'blocked_outside', format('Active on %s (Live in Control Tower)', conn), format('Blocked on %s as %s', conn, new.external_id),
          public.drift_actor(new.details ->> 'statusChangedBy', conn), 'Recorded',
          'No change in Control Tower: the agent stays Live here; its platform is stopping it');
  return null;
end $$;
create trigger platform_agents_status_drift after update of status on public.platform_agents
  for each row execute function public.platform_agents_status_drift();

-- Switched back on outside Control Tower (task 4.7): the reconciliation check records the drift; `changed_by` in the
-- results is the platform's own record of who did it.
create or replace function public.platform_reconcile_apply(p_token text, p_results jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.platform_jobs;
  c public.platform_connections;
  r jsonb;
  t record;
  s_id uuid;
  e_id bigint;
  inc public.incidents;
  msg text;
  who text;
  alert_id uuid;
  checked integer := 0;
  found_on text[] := '{}';
begin
  select * into j from public.platform_jobs where token_hash = public.secret_hash(coalesce(p_token, '')) for update;
  if not found or j.kind <> 'reconcile' or j.claimed_at is null or j.finished_at is not null or j.claimed_at < now() - interval '10 minutes' then
    raise exception 'Invalid or used job token' using errcode = 'invalid_authorization_specification';
  end if;
  if jsonb_typeof(p_results) is distinct from 'array' then
    raise exception 'results must be a list' using errcode = 'check_violation';
  end if;
  select * into c from public.platform_connections where id = j.connection_id;

  for r in select value from jsonb_array_elements(p_results) loop
    select * into t from public.reconcile_targets(c.id) x where x.platform_agent_id = (r ->> 'platform_agent_id')::uuid;
    continue when not found;
    checked := checked + 1;
    if r ->> 'status' = 'blocked' then
      update public.platform_agents set status = 'blocked', status_seen_at = now() where id = t.platform_agent_id;
      continue;
    end if;
    continue when r ->> 'status' is distinct from 'active';

    found_on := found_on || t.agent_code;
    who := public.drift_actor(r ->> 'changed_by', c.name);
    update public.platform_agents set status = 'active', status_seen_at = now() where id = t.platform_agent_id;
    select id into s_id from public.agent_suspensions where agent_id = t.agent_id and status = 'done'
     order by suspended_at desc nulls last limit 1;
    insert into public.agent_enforcements (agent_id, suspension_id, action, cause, method, target, platform_agent_id)
    values (t.agent_id, s_id, 'stop', 'reblock', 'platform', format('%s as %s', c.name, t.external_id), t.platform_agent_id)
    returning id into e_id;

    msg := format('%s was switched back on at %s as %s outside Control Tower (%s). It is being blocked again.',
                  t.agent_code, c.name, t.external_id, case when who like 'Unknown%' then 'actor unknown' else 'by ' || (r ->> 'changed_by') end);
    insert into public.audit_events (actor_id, actor_type, action, entity_type, entity_id, agent_id, summary, reason)
    values (null, 'system', 'agents.reactivated_outside', 'agents', t.agent_id, t.agent_id, msg,
            format('Reconciliation check: %s', case when who like 'Unknown%' then 'actor unknown, outside Control Tower' else who end));

    inc := public.incident_open(t.agent_id, 'reconciliation', 'critical',
      format('%s switched back on outside Control Tower', t.agent_code),
      format('The reconciliation check found %s active at %s as %s while it is suspended in Control Tower. Who switched it on: %s. It is being blocked again.',
             t.agent_code, c.name, t.external_id, who),
      jsonb_build_object('platform', c.name, 'external_id', t.external_id, 'found_at', now(), 'changed_by', r ->> 'changed_by'),
      'Control Tower reconciliation check (actor unknown, outside Control Tower)');

    insert into public.drift_events (agent_id, platform_agent_id, kind, expected, observed, actor, action, result, incident_id, enforcement_id)
    values (t.agent_id, t.platform_agent_id, 'switched_on_outside',
            format('Blocked on %s (suspended in Control Tower)', c.name), format('Active on %s as %s', c.name, t.external_id), who,
            format('Blocked again; Critical incident %s; admins alerted', inc.incident_code), 'Blocking again…', inc.id, e_id);

    update public.alerts set message = left(format('%s Incident %s.', msg, inc.incident_code), 1000), raised_at = now()
     where agent_id = t.agent_id and kind = 'outside_reactivation' and resolved_at is null
    returning id into alert_id;
    if alert_id is null then
      insert into public.alerts (kind, agent_id, message) values ('outside_reactivation', t.agent_id, left(format('%s Incident %s.', msg, inc.incident_code), 1000));
    end if;
    alert_id := null;
    insert into public.push_outbox (user_id, kind, title, body, url)
    select p.id, 'reconciliation', format('Switched on outside Control Tower · %s', t.agent_code),
           left(format('%s Critical incident %s opened.', msg, inc.incident_code), 300), '/agents/' || t.agent_id
      from public.profiles p
     where p.is_active and exists (select 1 from public.user_roles x where x.user_id = p.id and x.role = 'admin');
  end loop;

  if cardinality(found_on) > 0 then perform public.enforcement_kick(); end if;
  return jsonb_build_object('checked', checked, 'reblocked', cardinality(found_on), 'agents', to_jsonb(found_on));
end $$;

-- The drift's result follows its re-block.
create function public.drift_result_follows() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.cause <> 'reblock' or (new.status is not distinct from old.status and new.detail is not distinct from old.detail) then return null; end if;
  if new.status = 'pending' and new.attempts = 0 then return null; end if;
  update public.drift_events set result = case new.status
           when 'done' then format('Blocked again and read back as blocked at %s UTC', to_char(now() at time zone 'UTC', 'DD Mon HH24:MI'))
           when 'failed' then format('Not blocked again: %s. A person needs to act', coalesce(rtrim(new.detail, '. '), 'failed'))
           when 'cancelled' then 'Stopped trying: the agent is no longer suspended'
           else format('Not blocked yet: %s. Trying again', coalesce(rtrim(new.detail, '. '), 'no answer')) end
   where enforcement_id = new.id;
  return null;
end $$;
create trigger drift_result_follows after update of status, detail on public.agent_enforcements
  for each row execute function public.drift_result_follows();

revoke execute on function public.incident_critical_suspend(), public.force_review(uuid, text), public.incident_repeat_check(),
  public.agent_review_settles(), public.platform_agents_status_drift(), public.drift_result_follows()
  from public, anon, authenticated;
revoke execute on function public.can_close_incident(uuid, uuid), public.incident_closure_approvers(uuid),
  public.request_incident_closure(uuid, uuid, text), public.decide_incident_closure(uuid, boolean, text) from public, anon;
grant execute on function public.can_close_incident(uuid, uuid), public.incident_closure_approvers(uuid),
  public.request_incident_closure(uuid, uuid, text), public.decide_incident_closure(uuid, boolean, text) to authenticated;
