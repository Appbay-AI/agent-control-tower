-- Task 6.6 (R5.1, R5.2): the drift report and sync health. Done when: the reports match the records.
--   drift_report(from, to): every change made to an agent on its platform outside the Control Tower in the period
--     (whole days, UTC), with the agent, the platform record, what changed, who did it (when the platform says), what
--     the Control Tower did and the result, and the incident and enforcement step it led to; with counts by kind,
--     by actor and by agent. Each list stops at 2,000 rows and says so.
--   sync_health(days): for each agent platform, its last good fetch, its last failure, failures in a row now, fetches
--     and failures in the last 24 hours and in the period, the agents it lists now and those gone missing, what the
--     fetches found (new, back, missing, status changes) and the reconciliation checks, day by day.
-- Admins, executives and auditors only (the people who see every agent).

create function public.drift_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t0 timestamptz;
  t1 timestamptz;
  cap constant integer := 2000;
begin
  if not (public.is_active_user() and public.sees_everything()) then
    raise exception 'Only admins, executives and auditors can see the drift report' using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a start date on or before the end date' using errcode = 'invalid_parameter_value';
  end if;
  if p_to - p_from > 366 then
    raise exception 'Choose at most a year (366 days)' using errcode = 'invalid_parameter_value';
  end if;
  t0 := p_from::timestamp at time zone 'UTC';
  t1 := (p_to + 1)::timestamp at time zone 'UTC';

  return (
    with d as (
      select v.*, a.agent_code, a.name agent_name, a.status agent_status,
             (select name from public.departments where id = a.department_id) department,
             c.name platform, pa.external_id,
             i.incident_code, e.status enforcement_status, e.attempts enforcement_attempts
        from public.drift_events v
        join public.agents a on a.id = v.agent_id
        left join public.platform_agents pa on pa.id = v.platform_agent_id
        left join public.platform_connections c on c.id = pa.connection_id
        left join public.incidents i on i.id = v.incident_id
        left join public.agent_enforcements e on e.id = v.enforcement_id
       where v.detected_at >= t0 and v.detected_at < t1)
    select jsonb_build_object(
      'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', 'UTC'),
      'cap', cap,
      'total', (select count(*) from d),
      'rows', (select coalesce(jsonb_agg(r order by r ->> 'at' desc), '[]') from (
          select jsonb_build_object('id', id, 'at', detected_at, 'agent_id', agent_id, 'agent', agent_code || ' ' || agent_name,
                   'agent_status', agent_status, 'department', department, 'platform', platform, 'external_id', external_id,
                   'kind', kind, 'expected', expected, 'observed', observed, 'actor', actor, 'action', action, 'result', result,
                   'incident', incident_code, 'incident_id', incident_id,
                   'enforcement', case when enforcement_id is not null then jsonb_build_object('status', enforcement_status, 'attempts', enforcement_attempts) end) r
            from d order by detected_at desc limit cap) x),
      'by_kind', (select coalesce(jsonb_object_agg(kind, n), '{}') from (select kind, count(*) n from d group by kind) x),
      'by_actor', (select coalesce(jsonb_agg(jsonb_build_object('actor', actor, 'changes', n) order by n desc, actor), '[]')
                     from (select actor, count(*) n from d group by actor) x),
      'by_agent', (select coalesce(jsonb_agg(jsonb_build_object('agent_id', agent_id, 'agent', agent, 'changes', n, 'last', last) order by n desc, last desc), '[]')
                     from (select agent_id, max(agent_code || ' ' || agent_name) agent, count(*) n, max(detected_at) last from d group by agent_id) x)
    ));
end $$;

create function public.sync_health(p_days integer default 14) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  days integer := coalesce(p_days, 14);
  since timestamptz;
begin
  if not (public.is_active_user() and public.sees_everything()) then
    raise exception 'Only admins, executives and auditors can see sync health' using errcode = 'insufficient_privilege';
  end if;
  if days < 1 or days > 90 then
    raise exception 'Choose between 1 and 90 days' using errcode = 'invalid_parameter_value';
  end if;
  since := ((now() at time zone 'UTC')::date - (days - 1))::timestamp at time zone 'UTC';

  return jsonb_build_object(
    'at', now(),
    'days', days,
    'since', since,
    'platforms', (select coalesce(jsonb_agg(p order by p ->> 'name'), '[]') from (
      select jsonb_build_object(
        'id', c.id, 'name', c.name, 'kind', c.kind, 'every_minutes', c.sync_every_minutes,
        'last_ok', (select jsonb_build_object('at', j.finished_at, 'message', j.message) from public.platform_jobs j
                     where j.connection_id = c.id and j.kind = 'sync' and j.ok order by j.finished_at desc limit 1),
        'last_failure', (select jsonb_build_object('at', coalesce(j.finished_at, j.created_at), 'message', j.message) from public.platform_jobs j
                          where j.connection_id = c.id and j.kind = 'sync' and j.ok is false order by j.id desc limit 1),
        -- Failures in a row up to now (0 when the latest finished fetch worked).
        'failing_now', (select count(*) from public.platform_jobs j
                         where j.connection_id = c.id and j.kind = 'sync' and j.ok is false
                           and j.id > coalesce((select max(id) from public.platform_jobs k where k.connection_id = c.id and k.kind = 'sync' and k.ok), 0)),
        'day', (select jsonb_build_object('syncs', count(*), 'failed', count(*) filter (where ok is false))
                  from public.platform_jobs j where j.connection_id = c.id and j.kind = 'sync' and j.created_at >= now() - interval '24 hours'),
        'period', (select jsonb_build_object('syncs', count(*), 'failed', count(*) filter (where ok is false),
                     'not_finished', count(*) filter (where ok is null and created_at < now() - interval '10 minutes'),
                     'new', coalesce(sum((result ->> 'new')::int), 0), 'back', coalesce(sum((result ->> 'back')::int), 0),
                     'missing', coalesce(sum((result ->> 'missing')::int), 0), 'status_changed', coalesce(sum((result ->> 'status_changed')::int), 0),
                     'linked', coalesce(sum((result ->> 'linked')::int), 0), 'registered', coalesce(sum((result ->> 'registered')::int), 0))
                     from public.platform_jobs j where j.connection_id = c.id and j.kind = 'sync' and j.created_at >= since),
        'reconciliations', (select jsonb_build_object('checks', count(*), 'failed', count(*) filter (where ok is false),
                              'reblocked', coalesce(sum((result ->> 'reblocked')::int), 0))
                              from public.platform_jobs j where j.connection_id = c.id and j.kind = 'reconcile' and j.created_at >= since),
        'agents', jsonb_build_object(
          'listed', (select count(*) from public.platform_agents pa where pa.connection_id = c.id and pa.missing_since is null),
          'missing', (select count(*) from public.platform_agents pa where pa.connection_id = c.id and pa.missing_since is not null),
          'linked', (select count(*) from public.platform_agents pa where pa.connection_id = c.id and pa.missing_since is null and pa.agent_id is not null),
          'first_seen', (select count(*) from public.platform_agents pa where pa.connection_id = c.id and pa.first_seen_at >= since)),
        'by_day', (select jsonb_agg(jsonb_build_object('day', dd::date,
                     'syncs', (select count(*) from public.platform_jobs j where j.connection_id = c.id and j.kind = 'sync' and j.created_at >= dd and j.created_at < dd + interval '1 day'),
                     'failed', (select count(*) from public.platform_jobs j where j.connection_id = c.id and j.kind = 'sync' and j.ok is false and j.created_at >= dd and j.created_at < dd + interval '1 day'),
                     'changes', (select coalesce(sum(coalesce((result ->> 'new')::int, 0) + coalesce((result ->> 'back')::int, 0) + coalesce((result ->> 'missing')::int, 0)
                                                   + coalesce((result ->> 'status_changed')::int, 0)), 0)
                                   from public.platform_jobs j where j.connection_id = c.id and j.kind = 'sync' and j.created_at >= dd and j.created_at < dd + interval '1 day'))
                     order by dd)
                     from generate_series(since, since + make_interval(days => days - 1), interval '1 day') dd)) p
        from public.platform_connections c) x),
    -- The fetches that failed or found something in the period, most recent first.
    'notable', (select coalesce(jsonb_agg(r order by r ->> 'at' desc, (r ->> 'id')::bigint desc), '[]') from (
      select jsonb_build_object('id', j.id, 'platform', c.name, 'kind', j.kind, 'at', j.created_at, 'ok', j.ok, 'message', j.message) r
        from public.platform_jobs j join public.platform_connections c on c.id = j.connection_id
       where j.kind in ('sync', 'reconcile') and j.created_at >= since and public.evidence_sync_notable(j)
       order by j.created_at desc, j.id desc limit 200) x)
  );
end $$;

revoke execute on function public.drift_report(date, date), public.sync_health(integer) from public, anon;
grant execute on function public.drift_report(date, date), public.sync_health(integer) to authenticated;
