-- Task 6.3 (R5.3): the executive dashboard. Done when: it loads in under 3 seconds.
-- executive_dashboard() works out every figure in one call, in the database: agents by risk tier and status, where
-- they come from (found on an agent platform automatically, registered through the API, or by hand) and how much of
-- what the platforms list is governed, agents without an owner, overdue reviews, open incidents, everything waiting
-- for a decision, and how long approvals take (last 30 days, and week by week for 8 weeks). The same rules as the
-- registry screen: "no owner" counts registered agents (Approved, Live, Suspended) whose business owner is missing or
-- deactivated; a review is overdue when a Live agent's next review date has passed.
-- Admins, executives and auditors only (the people who see every agent).

create function public.executive_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  since timestamptz := now() - interval '30 days';
  weeks_from date := (date_trunc('week', now() at time zone 'UTC') - interval '7 weeks')::date;
begin
  if not (public.is_active_user() and public.sees_everything()) then
    raise exception 'Only admins, executives and auditors can see the dashboard' using errcode = 'insufficient_privilege';
  end if;

  return (
    with a as (
      select ag.id, ag.agent_code, ag.name, ag.status, ag.risk_tier, ag.next_review_date, ag.registration_source,
             exists (select 1 from public.platform_agents pa where pa.agent_id = ag.id) on_platform,
             (ag.business_owner_id is null or not coalesce(bo.is_active, false)) owner_missing
        from public.agents ag left join public.profiles bo on bo.id = ag.business_owner_id
       where ag.status <> 'retired'),
    weeks as (select g::date w from generate_series(weeks_from::timestamp, weeks_from::timestamp + interval '7 weeks', interval '7 days') g)
    select jsonb_build_object(
      'at', now(),
      'agents', (select count(*) from a),
      'by_status', (select jsonb_build_object(
          'proposed', count(*) filter (where status = 'proposed'), 'approved', count(*) filter (where status = 'approved'),
          'live', count(*) filter (where status = 'live'), 'suspended', count(*) filter (where status = 'suspended')) from a),
      'by_tier', (select jsonb_agg(jsonb_build_object('tier', t, 'agents', (select count(*) from a where a.risk_tier::text = t),
                                                       'live', (select count(*) from a where a.risk_tier::text = t and a.status = 'live')) order by o)
                    from unnest(array['low', 'medium', 'high', 'critical']) with ordinality x(t, o)),
      'by_source', (select jsonb_build_object(
          'platform', count(*) filter (where on_platform),
          'api', count(*) filter (where not on_platform and registration_source = 'api'),
          'manual', count(*) filter (where not on_platform and registration_source <> 'api')) from a),
      -- Coverage: of the agents the platforms list today, how many are governed (approved and not proposed).
      'coverage', (select jsonb_build_object(
          'listed', count(*),
          'governed', count(*) filter (where g.status in ('approved', 'live', 'suspended')),
          'awaiting', count(*) filter (where g.status = 'proposed'),
          'retired', count(*) filter (where g.status = 'retired'),
          'unlinked', count(*) filter (where g.id is null))
          from public.platform_agents pa left join public.agents g on g.id = pa.agent_id where pa.missing_since is null),
      'no_owner', (select jsonb_build_object('count', count(*),
          'agents', coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', agent_code, 'name', name) order by agent_code) filter (where rn <= 5), '[]'))
          from (select *, row_number() over (order by agent_code) rn from a where owner_missing and status in ('approved', 'live', 'suspended')) x),
      'overdue_reviews', (select jsonb_build_object('count', count(*),
          'agents', coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', agent_code, 'name', name, 'due', next_review_date) order by next_review_date) filter (where rn <= 5), '[]'))
          from (select *, row_number() over (order by next_review_date) rn from a
                 where status = 'live' and next_review_date < (now() at time zone 'UTC')::date) x),
      'incidents', (select jsonb_build_object(
          'open', count(*) filter (where status = 'open'),
          'contained', count(*) filter (where status = 'contained'),
          'overdue', count(*) filter (where status in ('open', 'contained') and due_at < now()),
          'by_severity', jsonb_build_object(
            'low', count(*) filter (where status in ('open', 'contained') and severity = 'low'),
            'medium', count(*) filter (where status in ('open', 'contained') and severity = 'medium'),
            'high', count(*) filter (where status in ('open', 'contained') and severity = 'high'),
            'critical', count(*) filter (where status in ('open', 'contained') and severity = 'critical')))
          from public.incidents),
      'incidents_by_week', (select jsonb_agg(jsonb_build_object('week', w,
          'low', (select count(*) from public.incidents i where i.opened_at >= w and i.opened_at < w + 7 and i.severity = 'low'),
          'medium', (select count(*) from public.incidents i where i.opened_at >= w and i.opened_at < w + 7 and i.severity = 'medium'),
          'high', (select count(*) from public.incidents i where i.opened_at >= w and i.opened_at < w + 7 and i.severity = 'high'),
          'critical', (select count(*) from public.incidents i where i.opened_at >= w and i.opened_at < w + 7 and i.severity = 'critical')) order by w)
          from weeks),
      'pending', jsonb_build_object(
          'registrations', (select count(*) from public.agent_registrations where status = 'pending'),
          'requests', (select count(*) from public.action_requests where status = 'pending'),
          'reactivations', (select count(*) from public.agent_reactivations where status = 'pending'),
          'closures', (select count(*) from public.incidents where closure_requested_at is not null and status <> 'closed'),
          'oldest', (select min(t) from (
              select submitted_at t from public.agent_registrations where status = 'pending'
              union all select requested_at from public.action_requests where status = 'pending'
              union all select requested_at from public.agent_reactivations where status = 'pending'
              union all select closure_requested_at from public.incidents where closure_requested_at is not null and status <> 'closed') o)),
      -- How long a person takes to decide: agents' action requests and agent registrations, last 30 days.
      'approval_time', jsonb_build_object(
          'requests', (select jsonb_build_object('decided', count(*),
              'avg_minutes', round(avg(extract(epoch from decided_at - requested_at) / 60)::numeric, 1),
              'median_minutes', round((percentile_cont(0.5) within group (order by extract(epoch from decided_at - requested_at) / 60))::numeric, 1))
              from public.action_requests where decision_source = 'human' and decided_at >= since),
          'registrations', (select jsonb_build_object('decided', count(*),
              'avg_minutes', round(avg(extract(epoch from decided_at - submitted_at) / 60)::numeric, 1),
              'median_minutes', round((percentile_cont(0.5) within group (order by extract(epoch from decided_at - submitted_at) / 60))::numeric, 1))
              from public.agent_registrations where status <> 'pending' and decided_at >= since)),
      'approval_time_by_week', (select jsonb_agg(jsonb_build_object('week', w,
          'decided', (select count(*) from public.action_requests q where q.decision_source = 'human' and q.decided_at >= w and q.decided_at < w + 7),
          'avg_minutes', (select round(avg(extract(epoch from q.decided_at - q.requested_at) / 60)::numeric, 1)
                            from public.action_requests q where q.decision_source = 'human' and q.decided_at >= w and q.decided_at < w + 7)) order by w)
          from weeks)
    ));
end $$;

-- The week-by-week figures read requests by decision time and incidents by opening time.
create index if not exists action_requests_decided_human on public.action_requests (decided_at) where decision_source = 'human';
create index if not exists incidents_opened_at on public.incidents (opened_at);

revoke execute on function public.executive_dashboard() from public, anon;
grant execute on function public.executive_dashboard() to authenticated;
