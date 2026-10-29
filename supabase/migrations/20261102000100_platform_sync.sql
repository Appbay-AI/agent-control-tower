-- Task 3.3: fetching agents from each connected platform, on a schedule and with "Sync now".
--
-- How often: each connection has its own interval, 30 minutes by default (the user's decision, 29 Oct: the build plan
-- said 5, but calling the Appian server every 5 minutes adds load to it). Admins can change it on the Integrations
-- page, or turn automatic syncing off. A database clock (pg_cron) looks every 5 minutes for connections that are due;
-- the platform itself is only called when its interval has passed. "Sync now" runs one at once.
--
-- What it does: a 'sync' job goes through the same path as "Test connection" (one-time token, our API runs the
-- plug-in). The API sends back every agent the platform listed; platform_sync_apply stores them in platform_agents:
-- new agents are added, known ones updated, and agents that are no longer listed are marked "missing at source"
-- (and cleared if they come back). Agents found, gone missing, back again, or blocked/unblocked on the platform are
-- written to the audit trail. Turning a discovered agent into a governed registry entry is task 3.5.

alter table public.platform_jobs drop constraint platform_jobs_kind_check;
alter table public.platform_jobs add constraint platform_jobs_kind_check check (kind in ('check', 'sync'));

alter table public.platform_connections add column sync_every_minutes integer default 30
  check (sync_every_minutes between 5 and 1440);
comment on column public.platform_connections.sync_every_minutes is
  'Task 3.3: fetch the agent list this often (minutes). Null = automatic sync off ("Sync now" still works).';

-- ---------------------------------------------------------------------------
-- Agents as each platform sees them
-- ---------------------------------------------------------------------------
create table public.platform_agents (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.platform_connections (id) on delete cascade,
  external_id text not null check (length(external_id) between 1 and 200),
  name text not null check (length(name) between 1 and 300),
  status text not null check (status in ('active', 'blocked')),
  owner_email text,
  owner_name text,
  department text,
  environment text,
  details jsonb not null,                -- everything the platform said, in Control Tower's words (the plug-in's PlatformAgent)
  agent_id uuid references public.agents (id) on delete set null,   -- the governed registry entry, once there is one (task 3.5)
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  missing_since timestamptz,             -- set when a sync no longer lists it ("missing at source")
  status_seen_at timestamptz not null default now(),  -- when we first saw its current status
  unique (connection_id, external_id)
);
create index platform_agents_agent on public.platform_agents (agent_id) where agent_id is not null;
alter table public.platform_agents enable row level security;
-- Everyone who sees the whole registry (admins, executives, auditors). Approvers and owners see governed agents only.
create policy "platform agents visible to those who see everything" on public.platform_agents for select to authenticated
  using (public.sees_everything());
revoke all on public.platform_agents from anon, authenticated;
grant select on public.platform_agents to authenticated;

-- ---------------------------------------------------------------------------
-- Starting jobs: one internal function, used by admins (check, Sync now) and by the clock (sync)
-- ---------------------------------------------------------------------------
create function public.platform_job_create(p_connection uuid, p_kind text, p_by uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  url text;
  token text;
  job_id bigint;
begin
  if not exists (select 1 from public.platform_connections where id = p_connection) then
    raise exception 'No such platform connection' using errcode = 'no_data_found';
  end if;
  if p_kind is null or p_kind not in ('check', 'sync') then
    raise exception 'Unknown job kind %', p_kind using errcode = 'check_violation';
  end if;

  -- Jobs the site never answered count as failed after two minutes.
  update public.platform_jobs set finished_at = now(), ok = false,
         message = case when claimed_at is null then 'Our site did not pick up the job within 2 minutes.'
                        else 'Our site did not report back within 2 minutes.' end
   where finished_at is null and created_at < now() - interval '2 minutes';

  -- Pressing the button twice, or the clock firing while a sync runs, does not start a second job.
  select id into job_id from public.platform_jobs
   where connection_id = p_connection and kind = p_kind and finished_at is null
   order by id desc limit 1;
  if job_id is not null then return job_id; end if;

  token := public.new_secret('pjt_');
  insert into public.platform_jobs (connection_id, kind, requested_by, token_hash)
  values (p_connection, p_kind, p_by, public.secret_hash(token))
  returning id into job_id;

  select site_url into url from public.push_config;
  if url is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    update public.platform_jobs set finished_at = now(), ok = false,
           message = 'This database does not know its site address yet (run the Database migrations workflow).'
     where id = job_id;
  else
    execute 'select net.http_post(url := $1, body := $2, timeout_milliseconds := 5000)'
      using url || '/api/v1/platforms/run', jsonb_build_object('token', token);
  end if;
  return job_id;
end $$;

create or replace function public.platform_job_start(p_connection uuid, p_kind text default 'check') returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can work with platform connections' using errcode = 'insufficient_privilege';
  end if;
  return public.platform_job_create(p_connection, p_kind, auth.uid());
end $$;

-- The clock: every 5 minutes, start a sync on each connection whose interval has passed since its last sync.
-- A minute's grace so a 30-minute interval is not pushed to 35 by the 5-minute tick.
create function public.platform_sync_due() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  n integer := 0;
begin
  for c in
    select pc.id from public.platform_connections pc
     where pc.sync_every_minutes is not null
       and exists (select 1 from public.platform_secrets s where s.connection_id = pc.id)
       and not exists (select 1 from public.platform_jobs j
                        where j.connection_id = pc.id and j.kind = 'sync'
                          and j.created_at > now() - make_interval(mins => pc.sync_every_minutes - 1))
  loop
    perform public.platform_job_create(c.id, 'sync', null);
    n := n + 1;
  end loop;
  return n;
end $$;

do $$
begin
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'platform-sync') then
      perform cron.unschedule('platform-sync');
    end if;
    perform cron.schedule('platform-sync', '*/5 * * * *', 'select public.platform_sync_due()');
  end if;
end $$;

-- Admins choose how often (null = off). Audited as a change to the connection.
create function public.set_platform_sync_interval(p_connection uuid, p_minutes integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can change platform connections' using errcode = 'insufficient_privilege';
  end if;
  if p_minutes is not null and (p_minutes < 5 or p_minutes > 1440) then
    raise exception 'Choose between 5 minutes and 1 day, or turn automatic sync off' using errcode = 'check_violation';
  end if;
  perform set_config('act.reason', case when p_minutes is null then 'Automatic sync turned off'
                                        else format('Sync every %s minutes', p_minutes) end, true);
  update public.platform_connections set sync_every_minutes = p_minutes, updated_at = now() where id = p_connection;
  if not found then raise exception 'No such platform connection' using errcode = 'no_data_found'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Storing what a sync found (our API, with the job's token, before it reports)
-- ---------------------------------------------------------------------------
create function public.platform_sync_audit(p_row public.platform_agents, p_action text, p_summary text) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_events (actor_id, actor_type, action, entity_type, entity_id, agent_id, summary, after)
  values (null, 'integration', p_action, 'platform_agents', p_row.id, p_row.agent_id, p_summary,
          jsonb_build_object('connection_id', p_row.connection_id, 'external_id', p_row.external_id, 'name', p_row.name,
                             'status', p_row.status, 'owner_email', p_row.owner_email, 'missing_since', p_row.missing_since));
$$;

create function public.platform_sync_apply(p_token text, p_agents jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.platform_jobs;
  c public.platform_connections;
  a jsonb;
  old public.platform_agents;
  r public.platform_agents;
  ids text[] := '{}';
  v_id text;
  v_status text;
  found_new integer := 0;
  status_changed integer := 0;
  came_back integer := 0;
  gone integer := 0;
begin
  select * into j from public.platform_jobs where token_hash = public.secret_hash(coalesce(p_token, '')) for update;
  if not found or j.kind <> 'sync' or j.claimed_at is null or j.finished_at is not null
     or j.claimed_at < now() - interval '10 minutes' then
    raise exception 'Invalid or used job token' using errcode = 'invalid_authorization_specification';
  end if;
  if jsonb_typeof(p_agents) is distinct from 'array' then
    raise exception 'agents must be a list' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_agents) > 5000 then
    raise exception 'More than 5,000 agents in one sync' using errcode = 'check_violation';
  end if;
  select * into c from public.platform_connections where id = j.connection_id;

  for a in select value from jsonb_array_elements(p_agents) loop
    v_id := a ->> 'externalId';
    v_status := a ->> 'status';
    if coalesce(v_id, '') = '' or coalesce(a ->> 'name', '') = '' or v_status is null or v_status not in ('active', 'blocked') then
      raise exception 'Agent % lacks an id, a name or a status of active or blocked', coalesce(v_id, '?') using errcode = 'check_violation';
    end if;
    if v_id = any (ids) then
      raise exception 'Agent % is listed twice', v_id using errcode = 'check_violation';
    end if;
    ids := ids || v_id;

    select * into old from public.platform_agents where connection_id = c.id and external_id = v_id for update;
    if not found then
      insert into public.platform_agents (connection_id, external_id, name, status, owner_email, owner_name, department, environment, details)
      values (c.id, v_id, a ->> 'name', v_status, a -> 'owner' ->> 'email', a -> 'owner' ->> 'name', a ->> 'department',
              a ->> 'environment', a)
      returning * into r;
      found_new := found_new + 1;
      perform public.platform_sync_audit(r, 'platform_agents.discovered',
        format('%s %s found on %s%s', v_id, r.name, c.name,
               case when r.owner_email is null then ' (no owner)' else '' end
               || case when v_status = 'blocked' then ' (blocked there)' else '' end));
    else
      update public.platform_agents
         set name = a ->> 'name', status = v_status, owner_email = a -> 'owner' ->> 'email', owner_name = a -> 'owner' ->> 'name',
             department = a ->> 'department', environment = a ->> 'environment', details = a,
             last_seen_at = now(), missing_since = null,
             status_seen_at = case when old.status = v_status then old.status_seen_at else now() end
       where id = old.id
      returning * into r;
      if old.missing_since is not null then
        came_back := came_back + 1;
        perform public.platform_sync_audit(r, 'platform_agents.back', format('%s %s is listed on %s again', v_id, r.name, c.name));
      end if;
      if old.status <> v_status then
        status_changed := status_changed + 1;
        perform public.platform_sync_audit(r, 'platform_agents.status_changed',
          format('%s %s is %s on %s (was %s)%s', v_id, r.name, v_status, c.name, old.status,
                 coalesce(' by ' || nullif(a ->> 'statusChangedBy', ''), '')));
      end if;
    end if;
  end loop;

  -- Listed before, not now: missing at source.
  for r in
    update public.platform_agents set missing_since = now()
     where connection_id = c.id and missing_since is null and not (external_id = any (ids))
    returning *
  loop
    gone := gone + 1;
    perform public.platform_sync_audit(r, 'platform_agents.missing', format('%s %s is no longer listed on %s', r.external_id, r.name, c.name));
  end loop;

  return jsonb_build_object('agents', jsonb_array_length(p_agents), 'new', found_new, 'status_changed', status_changed,
                            'back', came_back, 'missing', gone,
                            'blocked', (select count(*) from public.platform_agents where connection_id = c.id and missing_since is null and status = 'blocked'));
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on function public.platform_job_create(uuid, text, uuid), public.platform_sync_due(),
  public.set_platform_sync_interval(uuid, integer), public.platform_sync_audit(public.platform_agents, text, text),
  public.platform_sync_apply(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.set_platform_sync_interval(uuid, integer) to authenticated;
grant execute on function public.platform_sync_apply(text, jsonb) to anon;
