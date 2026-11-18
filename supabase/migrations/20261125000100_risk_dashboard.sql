-- Task 6.4: the risk dashboard. Done when: the figures match the data.
-- risk_dashboard() works out, in one call:
--   heat map: active agents (not retired) by department and risk tier, with each department's open incidents and
--             breaches in the last 90 days;
--   breach trend: week by week for 12 weeks, the four kinds of breach (an agent stepping outside its governance):
--             actions refused automatically because they broke the agent's limits, incidents opened, changes made on
--             the platform outside the Control Tower (drift), and people found with access to data without authority;
--   top agents by incidents: the 10 agents with the most incidents in the last 90 days.
-- Admins, executives and auditors only (the people who see every agent).

create function public.risk_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  since timestamptz := now() - interval '90 days';
  weeks_from date := (date_trunc('week', now() at time zone 'UTC') - interval '11 weeks')::date;
begin
  if not (public.is_active_user() and public.sees_everything()) then
    raise exception 'Only admins, executives and auditors can see the risk dashboard' using errcode = 'insufficient_privilege';
  end if;

  return (
    with a as (select id, department_id, risk_tier from public.agents where status <> 'retired'),
    -- Every breach, one row each: when, which agent, what kind.
    b as (
      select q.decided_at at_, q.agent_id, 'refused' kind from public.action_requests q where q.decision_source = 'policy' and q.status = 'refused'
      union all select i.opened_at, i.agent_id, 'incident' from public.incidents i
      union all select v.detected_at, v.agent_id, 'drift' from public.drift_events v
      union all select f.first_seen_at, f.agent_id, 'access' from public.agent_authority_findings f),
    depts as (
      select d.id, d.name from public.departments d where exists (select 1 from a where a.department_id = d.id)
      union all select null, 'No department' where exists (select 1 from a where a.department_id is null)),
    weeks as (select g::date w from generate_series(weeks_from::timestamp, weeks_from::timestamp + interval '11 weeks', interval '7 days') g)
    select jsonb_build_object(
      'at', now(),
      'since', since,
      'heat', (select coalesce(jsonb_agg(jsonb_build_object(
          'department', x.name,
          'low', (select count(*) from a where a.department_id is not distinct from x.id and a.risk_tier = 'low'),
          'medium', (select count(*) from a where a.department_id is not distinct from x.id and a.risk_tier = 'medium'),
          'high', (select count(*) from a where a.department_id is not distinct from x.id and a.risk_tier = 'high'),
          'critical', (select count(*) from a where a.department_id is not distinct from x.id and a.risk_tier = 'critical'),
          'agents', (select count(*) from a where a.department_id is not distinct from x.id),
          'open_incidents', (select count(*) from public.incidents i join public.agents g on g.id = i.agent_id
                              where g.department_id is not distinct from x.id and i.status in ('open', 'contained')),
          'breaches', (select count(*) from b join public.agents g on g.id = b.agent_id
                        where g.department_id is not distinct from x.id and b.at_ >= since))
          order by x.id is null, x.name), '[]') from depts x),
      'trend', (select jsonb_agg(jsonb_build_object('week', w,
          'refused', (select count(*) from b where kind = 'refused' and at_ >= w and at_ < w + 7),
          'incident', (select count(*) from b where kind = 'incident' and at_ >= w and at_ < w + 7),
          'drift', (select count(*) from b where kind = 'drift' and at_ >= w and at_ < w + 7),
          'access', (select count(*) from b where kind = 'access' and at_ >= w and at_ < w + 7)) order by w) from weeks),
      'totals', (select jsonb_build_object(
          'refused', count(*) filter (where kind = 'refused'), 'incident', count(*) filter (where kind = 'incident'),
          'drift', count(*) filter (where kind = 'drift'), 'access', count(*) filter (where kind = 'access'))
          from b where at_ >= since),
      'top_agents', (select coalesce(jsonb_agg(r order by (r ->> 'incidents')::int desc, r ->> 'last' desc, r ->> 'code'), '[]') from (
          select jsonb_build_object(
            'id', g.id, 'code', g.agent_code, 'name', g.name, 'status', g.status, 'risk_tier', g.risk_tier,
            'department', (select name from public.departments where id = g.department_id),
            'incidents', count(*),
            'open', count(*) filter (where i.status in ('open', 'contained')),
            'serious', count(*) filter (where i.severity in ('high', 'critical')),
            'last', max(i.opened_at)) r
            from public.incidents i join public.agents g on g.id = i.agent_id
           where i.opened_at >= since
           group by g.id
           order by count(*) desc, max(i.opened_at) desc, g.agent_code
           limit 10) t)
    ));
end $$;

create index if not exists action_requests_decided_policy on public.action_requests (decided_at) where decision_source = 'policy';
create index if not exists drift_events_detected_at on public.drift_events (detected_at);

revoke execute on function public.risk_dashboard() from public, anon;
grant execute on function public.risk_dashboard() to authenticated;
