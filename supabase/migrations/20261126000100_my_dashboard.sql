-- Task 6.5: the operational dashboard ("My work"). Done when: each user sees only their own.
-- my_dashboard() takes no person: it reads only the signed-in user (auth.uid()), so nobody can ask for anyone else's.
--   approvals: what is waiting for me to decide, by the same rules as the Approvals screen and the decision functions:
--     agents' action requests (can_decide_request), agent registrations (an approver for the agent's department or an
--     admin, not its owner, creator or submitter, not already decided by me), requests to switch an agent back on
--     (can_approve_reactivation, not already approved by me), and incident closures named to me;
--   my agents: the agents I own (business or technical owner), not retired, with what needs attention on each;
--   SLA breaches: what is mine and past its deadline: requests waiting for me past their due time, incidents I own or on
--     my agents past their due time, and reviews of my Live agents past their date.

create function public.my_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not public.is_active_user() then
    raise exception 'Sign in to see your work' using errcode = 'insufficient_privilege';
  end if;

  return (
    with req as (
      select q.id, q.request_code, q.action, q.amount, q.currency, q.requested_at, q.due_at, q.assigned_to, a.id agent_id, a.agent_code, a.name
        from public.action_requests q join public.agents a on a.id = q.agent_id
       where q.status = 'pending' and public.can_decide_request(q)),
    reg as (
      select g.id, g.submitted_at, a.id agent_id, a.agent_code, a.name, a.risk_tier
        from public.agent_registrations g join public.agents a on a.id = g.agent_id
       where g.status = 'pending'
         and (public.has_role('admin') or public.in_approver_scope(a.department_id))
         and me is distinct from a.business_owner_id and me is distinct from a.technical_owner_id
         and me is distinct from a.created_by and me is distinct from g.submitted_by
         and not exists (select 1 from public.registration_decisions d where d.registration_id = g.id and d.approver_id = me)),
    rea as (
      select x.id, x.requested_at, x.reason, a.id agent_id, a.agent_code, a.name
        from public.agent_reactivations x join public.agents a on a.id = x.agent_id
       where x.status = 'pending' and public.can_approve_reactivation(a.id, me)
         and not exists (select 1 from public.agent_reactivation_approvals y where y.reactivation_id = x.id and y.approver_id = me)),
    clo as (
      select i.id, i.incident_code, i.title, i.closure_requested_at, a.id agent_id, a.agent_code, a.name
        from public.incidents i join public.agents a on a.id = i.agent_id
       where i.closure_approver_id = me and i.closure_requested_at is not null and i.status <> 'closed'),
    mine as (
      select a.*, (a.business_owner_id = me) business, (a.technical_owner_id = me) technical
        from public.agents a
       where a.status <> 'retired' and me in (a.business_owner_id, a.technical_owner_id)),
    inc as (
      select i.id, i.incident_code, i.title, i.severity, i.status, i.due_at, i.owner_id, a.id agent_id, a.agent_code, a.name
        from public.incidents i join public.agents a on a.id = i.agent_id
       where i.status in ('open', 'contained')
         and (i.owner_id = me or me in (a.business_owner_id, a.technical_owner_id)))
    select jsonb_build_object(
      'at', now(),
      'me', (select full_name from public.profiles where id = me),
      'approvals', jsonb_build_object(
        'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', request_code, 'action', action, 'amount', amount,
                       'currency', currency, 'agent', agent_code || ' ' || name, 'agent_id', agent_id, 'requested_at', requested_at,
                       'due_at', due_at, 'assigned', coalesce(assigned_to = me, false)) order by due_at nulls last, requested_at), '[]') from req),
        'registrations', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'agent', agent_code || ' ' || name, 'agent_id', agent_id,
                       'risk_tier', risk_tier, 'submitted_at', submitted_at) order by submitted_at), '[]') from reg),
        'reactivations', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'agent', agent_code || ' ' || name, 'agent_id', agent_id,
                       'reason', reason, 'requested_at', requested_at) order by requested_at), '[]') from rea),
        'closures', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', incident_code, 'title', title, 'agent', agent_code || ' ' || name,
                       'agent_id', agent_id, 'requested_at', closure_requested_at) order by closure_requested_at), '[]') from clo)),
      'agents', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', m.id, 'code', m.agent_code, 'name', m.name, 'status', m.status, 'risk_tier', m.risk_tier,
          'role', case when m.business and m.technical then 'Business and technical owner' when m.business then 'Business owner' else 'Technical owner' end,
          'next_review', m.next_review_date,
          'review_overdue', m.status = 'live' and m.next_review_date < (now() at time zone 'UTC')::date,
          'review_required', m.review_required_reason,
          'open_incidents', (select count(*) from inc where inc.agent_id = m.id),
          'pending_requests', (select count(*) from public.action_requests q where q.agent_id = m.id and q.status = 'pending'))
          order by m.agent_code), '[]') from mine m),
      'breaches', (select coalesce(jsonb_agg(b order by b ->> 'due'), '[]') from (
          select jsonb_build_object('kind', 'request', 'id', id, 'title', request_code || ' ' || action, 'agent', agent_code || ' ' || name,
                                    'due', due_at, 'link', '/approvals/requests/' || id) b
            from req where due_at < now()
          union all
          select jsonb_build_object('kind', 'incident', 'id', id, 'title', incident_code || ' ' || title, 'agent', agent_code || ' ' || name,
                                    'due', due_at, 'link', '/incidents/' || id, 'severity', severity, 'owner', owner_id = me)
            from inc where due_at < now()
          union all
          select jsonb_build_object('kind', 'review', 'id', id, 'title', 'Review of ' || agent_code || ' ' || name, 'agent', agent_code || ' ' || name,
                                    'due', next_review_date, 'link', '/agents/' || id)
            from mine where status = 'live' and next_review_date < (now() at time zone 'UTC')::date) x)
    ));
end $$;

revoke execute on function public.my_dashboard() from public, anon;
grant execute on function public.my_dashboard() to authenticated;
