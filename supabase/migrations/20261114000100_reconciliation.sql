-- Task 4.7: the reconciliation loop (R2.4). Every 5 minutes the Control Tower reads, on each connected platform, the
-- status of every suspended agent that the platform had confirmed as blocked. One that reads active again was switched
-- back on outside the Control Tower (only an approved reactivation, task 4.6, may do that). It is then, in the same
-- cycle: blocked again (a new stop step, with the retries of task 4.3), put on the record as "switched back on outside
-- Control Tower, actor unknown", given a Critical incident, and raised as an alert with a phone alert to every admin.
-- With no suspended agents on a platform there is nothing to read and no call is made (the Appian server is spared).

alter type public.alert_kind add value if not exists 'outside_reactivation';

alter table public.platform_jobs drop constraint platform_jobs_kind_check;
alter table public.platform_jobs add constraint platform_jobs_kind_check check (kind in ('check', 'sync', 'reconcile'));

-- "reblock" = a stop step made by the reconciliation check after the agent was switched back on outside Control Tower.
alter table public.agent_enforcements
  add column cause text not null default 'suspension' check (cause in ('suspension', 'reblock'));

alter table public.incidents drop constraint incidents_source_check;
alter table public.incidents add constraint incidents_source_check
  check (source in ('suspension', 'agent_report', 'integration_report', 'user_report', 'reconciliation'));

alter table public.push_outbox drop constraint push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check
  check (kind in ('action_request', 'test', 'agent_discovered', 'suspension', 'enforcement', 'incident', 'reactivation', 'reconciliation'));

-- ---------------------------------------------------------------------------
-- What to check on a connection: suspended agents whose latest stop step there was confirmed (done), with nothing
-- still pending (a block in progress or being retried is task 4.3's business, not an outside switch-on).
-- ---------------------------------------------------------------------------
create function public.reconcile_targets(p_connection uuid)
returns table (platform_agent_id uuid, external_id text, agent_id uuid, agent_code text)
language sql stable security definer set search_path = '' as $$
  select pa.id, pa.external_id, a.id, a.agent_code
    from public.platform_agents pa
    join public.agents a on a.id = pa.agent_id and a.status = 'suspended'
   where pa.connection_id = p_connection and pa.missing_since is null
     and not exists (select 1 from public.agent_enforcements e
                      where e.platform_agent_id = pa.id and e.action = 'stop' and e.status = 'pending')
     and (select e.status from public.agent_enforcements e
           where e.platform_agent_id = pa.id and e.action = 'stop'
           order by e.id desc limit 1) = 'done'
$$;

-- platform_job_create now accepts 'reconcile'.
create or replace function public.platform_job_create(p_connection uuid, p_kind text, p_by uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  url text;
  token text;
  job_id bigint;
begin
  if not exists (select 1 from public.platform_connections where id = p_connection) then
    raise exception 'No such platform connection' using errcode = 'no_data_found';
  end if;
  if p_kind is null or p_kind not in ('check', 'sync', 'reconcile') then
    raise exception 'Unknown job kind %', p_kind using errcode = 'check_violation';
  end if;
  update public.platform_jobs set finished_at = now(), ok = false,
         message = case when claimed_at is null then 'Our site did not pick up the job within 2 minutes.'
                        else 'Our site did not report back within 2 minutes.' end
   where finished_at is null and created_at < now() - interval '2 minutes';
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
           message = 'This database does not know its site address yet (run the Database migrations workflow).' where id = job_id;
  else
    execute 'select net.http_post(url := $1, body := $2, timeout_milliseconds := 5000)'
      using url || '/api/v1/platforms/run', jsonb_build_object('token', token);
  end if;
  return job_id;
end $$;

-- The claim of a reconcile job carries the agents to read.
create or replace function public.platform_job_claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.platform_jobs;
  c public.platform_connections;
begin
  select * into j from public.platform_jobs where token_hash = public.secret_hash(coalesce(p_token, '')) for update;
  if not found or j.claimed_at is not null or j.finished_at is not null or j.created_at < now() - interval '10 minutes' then
    raise exception 'Invalid or used job token' using errcode = 'invalid_authorization_specification';
  end if;
  update public.platform_jobs set claimed_at = now() where id = j.id;
  select * into c from public.platform_connections where id = j.connection_id;
  return jsonb_build_object(
    'job', j.id,
    'kind', j.kind,
    'connection', jsonb_build_object('id', c.id, 'kind', c.kind, 'name', c.name, 'base_url', c.base_url,
      'secret', (select secret from public.platform_secrets where connection_id = c.id)),
    'targets', case when j.kind = 'reconcile' then
      (select coalesce(jsonb_agg(jsonb_build_object('platform_agent_id', t.platform_agent_id, 'external_id', t.external_id,
                                                   'agent_code', t.agent_code) order by t.external_id), '[]'::jsonb)
         from public.reconcile_targets(c.id) t) end);
end $$;

-- ---------------------------------------------------------------------------
-- Our API reports what it read: [{ "platform_agent_id": ..., "status": "active" | "blocked" | "missing" }]
-- ---------------------------------------------------------------------------
create function public.platform_reconcile_apply(p_token text, p_results jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.platform_jobs;
  c public.platform_connections;
  r jsonb;
  t record;
  s_id uuid;
  inc public.incidents;
  msg text;
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
    -- Only what is still a target now (the agent may have been reactivated with approval meanwhile).
    select * into t from public.reconcile_targets(c.id) x where x.platform_agent_id = (r ->> 'platform_agent_id')::uuid;
    continue when not found;
    checked := checked + 1;
    if r ->> 'status' = 'blocked' then
      update public.platform_agents set status = 'blocked', status_seen_at = now() where id = t.platform_agent_id;
      continue;
    end if;
    continue when r ->> 'status' is distinct from 'active';

    -- Switched back on outside the Control Tower.
    found_on := found_on || t.agent_code;
    update public.platform_agents set status = 'active', status_seen_at = now() where id = t.platform_agent_id;
    select id into s_id from public.agent_suspensions where agent_id = t.agent_id and status = 'done'
     order by suspended_at desc nulls last limit 1;
    insert into public.agent_enforcements (agent_id, suspension_id, action, cause, method, target, platform_agent_id)
    values (t.agent_id, s_id, 'stop', 'reblock', 'platform', format('%s as %s', c.name, t.external_id), t.platform_agent_id);

    msg := format('%s was switched back on at %s as %s outside Control Tower (actor unknown). It is being blocked again.',
                  t.agent_code, c.name, t.external_id);
    insert into public.audit_events (actor_id, actor_type, action, entity_type, entity_id, agent_id, summary, reason)
    values (null, 'system', 'agents.reactivated_outside', 'agents', t.agent_id, t.agent_id, msg,
            'Reconciliation check: actor unknown, outside Control Tower');

    inc := public.incident_open(t.agent_id, 'reconciliation', 'critical',
      format('%s switched back on outside Control Tower', t.agent_code),
      format('The reconciliation check found %s active at %s as %s while it is suspended in Control Tower. Who switched it on is unknown: it was done outside Control Tower. It is being blocked again.',
             t.agent_code, c.name, t.external_id),
      jsonb_build_object('platform', c.name, 'external_id', t.external_id, 'found_at', now()),
      'Control Tower reconciliation check (actor unknown, outside Control Tower)');

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

-- The alert clears once the agent is confirmed blocked again, or is no longer suspended.
create function public.outside_reactivation_clear() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.cause = 'reblock' and new.status in ('done', 'cancelled') and old.status is distinct from new.status then
    update public.alerts set resolved_at = now() where agent_id = new.agent_id and kind = 'outside_reactivation' and resolved_at is null;
  end if;
  return null;
end $$;
create trigger outside_reactivation_clear after update of status on public.agent_enforcements
  for each row execute function public.outside_reactivation_clear();

-- ---------------------------------------------------------------------------
-- The clock: every 5 minutes, one job per connection that has something to check.
-- ---------------------------------------------------------------------------
create function public.platform_reconcile_due() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  n integer := 0;
begin
  for c in
    select pc.id from public.platform_connections pc
     where exists (select 1 from public.platform_secrets s where s.connection_id = pc.id)
       and exists (select 1 from public.reconcile_targets(pc.id))
  loop
    perform public.platform_job_create(c.id, 'reconcile', null);
    n := n + 1;
  end loop;
  return n;
end $$;

do $$
begin
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'platform-reconcile') then
      perform cron.unschedule('platform-reconcile');
    end if;
    perform cron.schedule('platform-reconcile', '*/5 * * * *', 'select public.platform_reconcile_due()');
  end if;
end $$;

revoke execute on function public.reconcile_targets(uuid), public.platform_reconcile_due(), public.outside_reactivation_clear()
  from public, anon, authenticated;
revoke execute on function public.platform_reconcile_apply(text, jsonb) from public, authenticated;
grant execute on function public.platform_reconcile_apply(text, jsonb) to anon;
