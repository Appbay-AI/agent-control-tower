-- Task 6.1 (R5.5): the evidence pack. Pick a date range, one click, a PDF for an auditor.
-- evidence_pack(from, to) gathers, for that range (whole days, UTC), everything the PDF prints:
--   inventory (every agent registered by the end of the range, as it stands now), approvals (registrations and agents'
--   action requests decided by people), incidents, autonomy changes, reviews, kill-switch events (suspensions,
--   reactivations and every platform / webhook / email step), drift, re-quarantine actions, sync history, and an
--   attestation: the audit trail's hash chain checked end to end, the period's first and last audit entries, and a
--   SHA-256 digest of the pack's contents. Producing a pack is itself recorded in the audit trail
--   (evidence_pack.generated), whose number is printed on the pack.
-- Admins, executives and auditors only (the people who see every agent). Each list stops at 2,000 rows; the PDF says so.

create function public.evidence_pack(p_from date, p_to date) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  t0 timestamptz;
  t1 timestamptz;
  cap constant integer := 2000;
  me public.profiles;
  pack jsonb;
  chain record;
  chain_len bigint;
  digest text;
  pack_seq bigint;
  first_ev record;
  last_ev record;
begin
  if not (public.is_active_user() and public.sees_everything()) then
    raise exception 'Only admins, executives and auditors can produce the evidence pack' using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a start date on or before the end date' using errcode = 'invalid_parameter_value';
  end if;
  if p_to - p_from > 366 then
    raise exception 'Choose at most a year (366 days)' using errcode = 'invalid_parameter_value';
  end if;
  t0 := p_from::timestamp at time zone 'UTC';
  t1 := (p_to + 1)::timestamp at time zone 'UTC';
  select * into me from public.profiles where id = auth.uid();

  pack := jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', 'UTC'),
    'generated', jsonb_build_object(
      'at', now(), 'by', me.full_name, 'email', me.email, 'job_title', me.job_title,
      'roles', (select coalesce(jsonb_agg(role order by role), '[]') from public.user_roles where user_id = me.id)),
    'cap', cap,

    -- Every agent registered by the end of the period, as it stands now.
    'inventory', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'code') filter (where n <= cap), '[]'))
      from (select row_number() over (order by a.agent_code) n, jsonb_build_object(
              'code', a.agent_code, 'name', a.name, 'department', d.name,
              'business_owner', bo.full_name, 'technical_owner', tech.full_name,
              'risk_tier', a.risk_tier, 'autonomy_level', a.autonomy_level, 'status', a.status,
              'source', coalesce((select c.name from public.platform_agents pa join public.platform_connections c on c.id = pa.connection_id
                                   where pa.agent_id = a.id limit 1), case a.registration_source when 'api' then 'API' else 'Manual' end),
              'data', a.data_classifications, 'registered', a.created_at, 'approved_at', a.approved_at,
              'last_review', a.last_review_date, 'next_review', a.next_review_date,
              'review_required', a.review_required_reason) r
              from public.agents a
              left join public.departments d on d.id = a.department_id
              left join public.profiles bo on bo.id = a.business_owner_id
              left join public.profiles tech on tech.id = a.technical_owner_id
             where a.created_at < t1) x),

    -- Registrations decided in the period, with each approver's decision.
    'registrations', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'decided_at') filter (where n <= cap), '[]'))
      from (select row_number() over (order by g.decided_at) n, jsonb_build_object(
              'agent', a.agent_code || ' ' || a.name, 'submitted_at', g.submitted_at, 'decided_at', g.decided_at,
              'outcome', g.status, 'required', g.required_approvals, 'reason', g.decision_reason,
              'decisions', (select coalesce(jsonb_agg(jsonb_build_object('by', p.full_name, 'decision', x.decision, 'reason', x.reason, 'at', x.decided_at)
                                                      order by x.decided_at), '[]')
                              from public.registration_decisions x join public.profiles p on p.id = x.approver_id where x.registration_id = g.id)) r
              from public.agent_registrations g join public.agents a on a.id = g.agent_id
             where g.decided_at >= t0 and g.decided_at < t1 and g.status <> 'pending') x),

    -- Agents' action requests that people approved or rejected in the period.
    'requests', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'decided_at') filter (where n <= cap), '[]'),
                                           'expired', (select count(*) from public.action_requests where decision_source = 'timeout' and decided_at >= t0 and decided_at < t1),
                                           'refused', (select count(*) from public.action_requests where decision_source = 'policy' and decided_at >= t0 and decided_at < t1))
      from (select row_number() over (order by q.decided_at) n, jsonb_build_object(
              'code', q.request_code, 'agent', a.agent_code || ' ' || a.name, 'action', q.action,
              'amount', q.amount, 'currency', q.currency, 'requested_at', q.requested_at, 'decided_at', q.decided_at,
              'outcome', q.status, 'required', q.required_approvals, 'reason', q.decision_reason,
              'approvers', coalesce((select jsonb_agg(p.full_name order by x.approved_at) from public.action_request_approvals x
                                       join public.profiles p on p.id = x.approver_id where x.request_id = q.id), '[]'),
              'decided_by', (select full_name from public.profiles where id = q.decided_by)) r
              from public.action_requests q join public.agents a on a.id = q.agent_id
             where q.decision_source = 'human' and q.decided_at >= t0 and q.decided_at < t1) x),

    -- Incidents opened in the period, closed in it, or still not closed at its end.
    'incidents', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'opened_at') filter (where n <= cap), '[]'))
      from (select row_number() over (order by i.opened_at) n, jsonb_build_object(
              'code', i.incident_code, 'agent', a.agent_code || ' ' || a.name, 'severity', i.severity, 'status', i.status,
              'title', i.title, 'source', i.source, 'owner', o.full_name, 'opened_at', i.opened_at, 'due_at', i.due_at,
              'closed_at', i.closed_at) r
              from public.incidents i join public.agents a on a.id = i.agent_id left join public.profiles o on o.id = i.owner_id
             where i.opened_at < t1 and (i.opened_at >= t0 or i.closed_at is null or i.closed_at >= t0)) x),

    -- Autonomy level changes, from the audit trail.
    'autonomy', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by (r ->> 'seq')::bigint) filter (where n <= cap), '[]'))
      from (select row_number() over (order by e.seq) n, jsonb_build_object(
              'seq', e.seq, 'at', e.occurred_at, 'agent', coalesce(e.after ->> 'agent_code', '') || ' ' || coalesce(e.after ->> 'name', ''),
              'from', (e.before ->> 'autonomy_level')::int, 'to', (e.after ->> 'autonomy_level')::int,
              'by', coalesce(p.full_name, initcap(e.actor_type)), 'reason', e.reason) r
              from public.audit_events e left join public.profiles p on p.id = e.actor_id
             where e.entity_type = 'agents' and e.occurred_at >= t0 and e.occurred_at < t1
               and e.before ? 'autonomy_level' and e.before ->> 'autonomy_level' is distinct from e.after ->> 'autonomy_level') x),

    -- Reviews done in the period.
    'reviews', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'at') filter (where n <= cap), '[]'))
      from (select row_number() over (order by v.reviewed_at) n, jsonb_build_object(
              'agent', a.agent_code || ' ' || a.name, 'at', v.reviewed_at, 'by', p.full_name, 'outcome', v.outcome,
              'notes', v.notes, 'next', v.next_review_date) r
              from public.agent_reviews v join public.agents a on a.id = v.agent_id left join public.profiles p on p.id = v.reviewer_id
             where v.reviewed_at >= t0 and v.reviewed_at < t1) x),

    -- Kill switch: suspensions asked for in the period, requests to switch back on, and each step taken on a platform,
    -- by webhook or by email.
    'suspensions', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'requested_at') filter (where n <= cap), '[]'))
      from (select row_number() over (order by s.requested_at) n, jsonb_build_object(
              'agent', a.agent_code || ' ' || a.name, 'status', s.status, 'reason', s.reason,
              'requested_by', rq.full_name, 'requested_at', s.requested_at, 'confirmed_by', cf.full_name,
              'suspended_at', s.suspended_at, 'withdrawn_at', s.withdrawn_at) r
              from public.agent_suspensions s join public.agents a on a.id = s.agent_id
              left join public.profiles rq on rq.id = s.requested_by left join public.profiles cf on cf.id = s.confirmed_by
             where s.requested_at >= t0 and s.requested_at < t1) x),
    'reactivations', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'requested_at') filter (where n <= cap), '[]'))
      from (select row_number() over (order by x.requested_at) n, jsonb_build_object(
              'agent', a.agent_code || ' ' || a.name, 'status', x.status, 'reason', x.reason,
              'requested_by', rq.full_name, 'requested_at', x.requested_at, 'decided_at', x.decided_at,
              'decision_reason', x.decision_reason,
              'approvers', coalesce((select jsonb_agg(p.full_name order by y.approved_at) from public.agent_reactivation_approvals y
                                       join public.profiles p on p.id = y.approver_id where y.reactivation_id = x.id), '[]')) r
              from public.agent_reactivations x join public.agents a on a.id = x.agent_id left join public.profiles rq on rq.id = x.requested_by
             where x.requested_at >= t0 and x.requested_at < t1) x),
    'enforcement', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by (r ->> 'id')::bigint) filter (where n <= cap), '[]'))
      from (select row_number() over (order by e.id) n, jsonb_build_object(
              'id', e.id, 'agent', a.agent_code || ' ' || a.name, 'action', e.action, 'cause', e.cause, 'method', e.method,
              'target', e.target, 'status', e.status, 'attempts', e.attempts, 'detail', e.detail,
              'created_at', e.created_at, 'finished_at', e.finished_at) r
              from public.agent_enforcements e join public.agents a on a.id = e.agent_id
             where e.created_at >= t0 and e.created_at < t1 and e.cause <> 'reblock') x),

    -- Drift: changes made on the platform outside the Control Tower.
    'drift', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'at') filter (where n <= cap), '[]'))
      from (select row_number() over (order by v.detected_at) n, jsonb_build_object(
              'agent', a.agent_code || ' ' || a.name, 'at', v.detected_at, 'kind', v.kind, 'expected', v.expected,
              'observed', v.observed, 'actor', v.actor, 'action', v.action, 'result', v.result,
              'incident', (select incident_code from public.incidents where id = v.incident_id)) r
              from public.drift_events v join public.agents a on a.id = v.agent_id
             where v.detected_at >= t0 and v.detected_at < t1) x),

    -- Re-quarantine: agents switched back on outside the Control Tower and blocked again (task 4.7).
    'requarantine', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by (r ->> 'id')::bigint) filter (where n <= cap), '[]'))
      from (select row_number() over (order by e.id) n, jsonb_build_object(
              'id', e.id, 'agent', a.agent_code || ' ' || a.name, 'target', e.target, 'status', e.status, 'attempts', e.attempts,
              'detail', e.detail, 'created_at', e.created_at, 'finished_at', e.finished_at) r
              from public.agent_enforcements e join public.agents a on a.id = e.agent_id
             where e.created_at >= t0 and e.created_at < t1 and e.cause = 'reblock') x),

    -- Sync history: every fetch of each platform's agent list and every reconciliation check; listed are the ones that
    -- failed or found something, with counts for the rest.
    'sync', jsonb_build_object(
      'platforms', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', c.name, 'kind', c.kind, 'every_minutes', c.sync_every_minutes,
          'syncs', (select count(*) from public.platform_jobs j where j.connection_id = c.id and j.kind = 'sync' and j.created_at >= t0 and j.created_at < t1),
          'failed', (select count(*) from public.platform_jobs j where j.connection_id = c.id and j.kind = 'sync' and j.ok is false and j.created_at >= t0 and j.created_at < t1),
          'reconciliations', (select count(*) from public.platform_jobs j where j.connection_id = c.id and j.kind = 'reconcile' and j.created_at >= t0 and j.created_at < t1),
          'last_sync', (select max(j.finished_at) from public.platform_jobs j where j.connection_id = c.id and j.kind = 'sync' and j.ok and j.created_at < t1),
          'agents', (select count(*) from public.platform_agents pa where pa.connection_id = c.id and pa.missing_since is null)) order by c.name), '[]')
        from public.platform_connections c),
      'total', (select count(*) from public.platform_jobs j
                 where j.kind in ('sync', 'reconcile') and j.created_at >= t0 and j.created_at < t1 and public.evidence_sync_notable(j)),
      'rows', (select coalesce(jsonb_agg(r order by (r ->> 'id')::bigint), '[]') from (
                 select jsonb_build_object('id', j.id, 'platform', c.name, 'kind', j.kind, 'at', j.created_at,
                                           'ok', j.ok, 'message', j.message) r
                   from public.platform_jobs j join public.platform_connections c on c.id = j.connection_id
                  where j.kind in ('sync', 'reconcile') and j.created_at >= t0 and j.created_at < t1 and public.evidence_sync_notable(j)
                  order by j.id limit cap) x))
  );

  -- Attestation.
  select count(*) into chain_len from public.audit_events;
  select * into chain from public.audit_verify_chain() limit 1;
  select e.seq, e.occurred_at, e.hash into first_ev from public.audit_events e where e.occurred_at >= t0 and e.occurred_at < t1 order by e.seq limit 1;
  select e.seq, e.occurred_at, e.hash into last_ev from public.audit_events e where e.occurred_at >= t0 and e.occurred_at < t1 order by e.seq desc limit 1;
  digest := encode(sha256(convert_to(pack::text, 'UTF8')), 'hex');

  insert into public.audit_events (actor_id, actor_type, action, entity_type, summary, reason, after)
  values (auth.uid(), 'user', 'evidence_pack.generated', 'evidence_pack',
          format('Evidence pack %s to %s produced by %s', p_from, p_to, coalesce(me.full_name, 'someone')),
          null, jsonb_build_object('from', p_from, 'to', p_to, 'digest', digest))
  returning audit_events.seq into pack_seq;

  return pack || jsonb_build_object('attestation', jsonb_build_object(
    'pack_seq', pack_seq,
    'digest', digest,
    'chain_intact', chain.broken_seq is null,
    'chain_broken_at', chain.broken_seq,
    'chain_length', chain_len,
    'period_events', (select count(*) from public.audit_events e where e.occurred_at >= t0 and e.occurred_at < t1),
    'period_first', case when first_ev.seq is not null then jsonb_build_object('seq', first_ev.seq, 'at', first_ev.occurred_at, 'hash', first_ev.hash) end,
    'period_last', case when last_ev.seq is not null then jsonb_build_object('seq', last_ev.seq, 'at', last_ev.occurred_at, 'hash', last_ev.hash) end,
    'latest_hash', (select hash from public.audit_events order by seq desc limit 1)));
end $$;

-- A sync or reconciliation worth listing: it failed, or it found or changed something.
create function public.evidence_sync_notable(j public.platform_jobs) returns boolean
language sql immutable set search_path = '' as $$
  select j.ok is not true
      or (j.kind = 'sync' and coalesce((j.result ->> 'new')::int, 0) + coalesce((j.result ->> 'missing')::int, 0)
                              + coalesce((j.result ->> 'back')::int, 0) + coalesce((j.result ->> 'status_changed')::int, 0)
                              + coalesce((j.result ->> 'linked')::int, 0) + coalesce((j.result ->> 'registered')::int, 0) > 0)
      or (j.kind = 'reconcile' and coalesce((j.result ->> 'reblocked')::int, 0) + coalesce((j.result ->> 'unreadable')::int, 0) > 0)
$$;

revoke execute on function public.evidence_pack(date, date), public.evidence_sync_notable(public.platform_jobs) from public, anon;
grant execute on function public.evidence_pack(date, date) to authenticated;
revoke execute on function public.evidence_sync_notable(public.platform_jobs) from authenticated;
