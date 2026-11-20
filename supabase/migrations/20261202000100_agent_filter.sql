-- 20 Nov: the evidence pack for one agent. evidence_pack(from, to, agent) is the same pack with every list kept to that
-- agent: its inventory row, approvals, incidents, autonomy changes, reviews, kill-switch events, drift and
-- re-quarantine actions, the sync history of the platform(s) it runs on, and in the attestation the agent's own audit
-- entries in the period (the whole chain is still checked). Without an agent it is the pack for every agent, as before.
-- The pack names the agent (so its digest covers it), and so does the evidence_pack.generated entry.

drop function public.evidence_pack(date, date);

create function public.evidence_pack(p_from date, p_to date, p_agent uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = '' set statement_timeout = '60s' as $$
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
  ag public.agents;
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
  if p_agent is not null then
    select * into ag from public.agents where id = p_agent;
    if ag.id is null then raise exception 'Agent not found' using errcode = 'no_data_found'; end if;
  end if;
  t0 := p_from::timestamp at time zone 'UTC';
  t1 := (p_to + 1)::timestamp at time zone 'UTC';
  select * into me from public.profiles where id = auth.uid();

  pack := jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', 'UTC'),
    -- The one agent the pack covers, or null for every agent.
    'agent', case when ag.id is not null then jsonb_build_object('id', ag.id, 'code', ag.agent_code, 'name', ag.name) end,
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
             where a.created_at < t1 and (p_agent is null or a.id = p_agent)) x),

    -- Registrations decided in the period, with each approver's decision.
    'registrations', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'decided_at') filter (where n <= cap), '[]'))
      from (select row_number() over (order by g.decided_at) n, jsonb_build_object(
              'agent', a.agent_code || ' ' || a.name, 'submitted_at', g.submitted_at, 'decided_at', g.decided_at,
              'outcome', g.status, 'required', g.required_approvals, 'reason', g.decision_reason,
              'decisions', (select coalesce(jsonb_agg(jsonb_build_object('by', p.full_name, 'decision', x.decision, 'reason', x.reason, 'at', x.decided_at)
                                                      order by x.decided_at), '[]')
                              from public.registration_decisions x join public.profiles p on p.id = x.approver_id where x.registration_id = g.id)) r
              from public.agent_registrations g join public.agents a on a.id = g.agent_id
             where g.decided_at >= t0 and g.decided_at < t1 and g.status <> 'pending' and (p_agent is null or a.id = p_agent)) x),

    -- Agents' action requests that people approved or rejected in the period.
    'requests', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'decided_at') filter (where n <= cap), '[]'),
                                           'expired', (select count(*) from public.action_requests where decision_source = 'timeout' and decided_at >= t0 and decided_at < t1 and (p_agent is null or agent_id = p_agent)),
                                           'refused', (select count(*) from public.action_requests where decision_source = 'policy' and decided_at >= t0 and decided_at < t1 and (p_agent is null or agent_id = p_agent)))
      from (select row_number() over (order by q.decided_at) n, jsonb_build_object(
              'code', q.request_code, 'agent', a.agent_code || ' ' || a.name, 'action', q.action,
              'amount', q.amount, 'currency', q.currency, 'requested_at', q.requested_at, 'decided_at', q.decided_at,
              'outcome', q.status, 'required', q.required_approvals, 'reason', q.decision_reason,
              'approvers', coalesce((select jsonb_agg(p.full_name order by x.approved_at) from public.action_request_approvals x
                                       join public.profiles p on p.id = x.approver_id where x.request_id = q.id), '[]'),
              'decided_by', (select full_name from public.profiles where id = q.decided_by)) r
              from public.action_requests q join public.agents a on a.id = q.agent_id
             where q.decision_source = 'human' and q.decided_at >= t0 and q.decided_at < t1 and (p_agent is null or a.id = p_agent)) x),

    -- Incidents opened in the period, closed in it, or still not closed at its end.
    'incidents', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'opened_at') filter (where n <= cap), '[]'))
      from (select row_number() over (order by i.opened_at) n, jsonb_build_object(
              'code', i.incident_code, 'agent', a.agent_code || ' ' || a.name, 'severity', i.severity, 'status', i.status,
              'title', i.title, 'source', i.source, 'owner', o.full_name, 'opened_at', i.opened_at, 'due_at', i.due_at,
              'closed_at', i.closed_at) r
              from public.incidents i join public.agents a on a.id = i.agent_id left join public.profiles o on o.id = i.owner_id
             where i.opened_at < t1 and (i.opened_at >= t0 or i.closed_at is null or i.closed_at >= t0) and (p_agent is null or a.id = p_agent)) x),

    -- Autonomy level changes, from the audit trail.
    'autonomy', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by (r ->> 'seq')::bigint) filter (where n <= cap), '[]'))
      from (select row_number() over (order by e.seq) n, jsonb_build_object(
              'seq', e.seq, 'at', e.occurred_at, 'agent', coalesce(e.after ->> 'agent_code', '') || ' ' || coalesce(e.after ->> 'name', ''),
              'from', (e.before ->> 'autonomy_level')::int, 'to', (e.after ->> 'autonomy_level')::int,
              'by', coalesce(p.full_name, initcap(e.actor_type)), 'reason', e.reason) r
              from public.audit_events e left join public.profiles p on p.id = e.actor_id
             where e.entity_type = 'agents' and e.occurred_at >= t0 and e.occurred_at < t1 and (p_agent is null or e.agent_id = p_agent)
               and e.before ? 'autonomy_level' and e.before ->> 'autonomy_level' is distinct from e.after ->> 'autonomy_level') x),

    -- Reviews done in the period.
    'reviews', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'at') filter (where n <= cap), '[]'))
      from (select row_number() over (order by v.reviewed_at) n, jsonb_build_object(
              'agent', a.agent_code || ' ' || a.name, 'at', v.reviewed_at, 'by', p.full_name, 'outcome', v.outcome,
              'notes', v.notes, 'next', v.next_review_date) r
              from public.agent_reviews v join public.agents a on a.id = v.agent_id left join public.profiles p on p.id = v.reviewer_id
             where v.reviewed_at >= t0 and v.reviewed_at < t1 and (p_agent is null or a.id = p_agent)) x),

    -- Kill switch: suspensions asked for in the period, requests to switch back on, and each step taken on a platform,
    -- by webhook or by email.
    'suspensions', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'requested_at') filter (where n <= cap), '[]'))
      from (select row_number() over (order by s.requested_at) n, jsonb_build_object(
              'agent', a.agent_code || ' ' || a.name, 'status', s.status, 'reason', s.reason,
              'requested_by', rq.full_name, 'requested_at', s.requested_at, 'confirmed_by', cf.full_name,
              'suspended_at', s.suspended_at, 'withdrawn_at', s.withdrawn_at) r
              from public.agent_suspensions s join public.agents a on a.id = s.agent_id
              left join public.profiles rq on rq.id = s.requested_by left join public.profiles cf on cf.id = s.confirmed_by
             where s.requested_at >= t0 and s.requested_at < t1 and (p_agent is null or a.id = p_agent)) x),
    'reactivations', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'requested_at') filter (where n <= cap), '[]'))
      from (select row_number() over (order by x.requested_at) n, jsonb_build_object(
              'agent', a.agent_code || ' ' || a.name, 'status', x.status, 'reason', x.reason,
              'requested_by', rq.full_name, 'requested_at', x.requested_at, 'decided_at', x.decided_at,
              'decision_reason', x.decision_reason,
              'approvers', coalesce((select jsonb_agg(p.full_name order by y.approved_at) from public.agent_reactivation_approvals y
                                       join public.profiles p on p.id = y.approver_id where y.reactivation_id = x.id), '[]')) r
              from public.agent_reactivations x join public.agents a on a.id = x.agent_id left join public.profiles rq on rq.id = x.requested_by
             where x.requested_at >= t0 and x.requested_at < t1 and (p_agent is null or a.id = p_agent)) x),
    'enforcement', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by (r ->> 'id')::bigint) filter (where n <= cap), '[]'))
      from (select row_number() over (order by e.id) n, jsonb_build_object(
              'id', e.id, 'agent', a.agent_code || ' ' || a.name, 'action', e.action, 'cause', e.cause, 'method', e.method,
              'target', e.target, 'status', e.status, 'attempts', e.attempts, 'detail', e.detail,
              'created_at', e.created_at, 'finished_at', e.finished_at) r
              from public.agent_enforcements e join public.agents a on a.id = e.agent_id
             where e.created_at >= t0 and e.created_at < t1 and e.cause <> 'reblock' and (p_agent is null or a.id = p_agent)) x),

    -- Drift: changes made on the platform outside the Control Tower.
    'drift', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by r ->> 'at') filter (where n <= cap), '[]'))
      from (select row_number() over (order by v.detected_at) n, jsonb_build_object(
              'agent', a.agent_code || ' ' || a.name, 'at', v.detected_at, 'kind', v.kind, 'expected', v.expected,
              'observed', v.observed, 'actor', v.actor, 'action', v.action, 'result', v.result,
              'incident', (select incident_code from public.incidents where id = v.incident_id)) r
              from public.drift_events v join public.agents a on a.id = v.agent_id
             where v.detected_at >= t0 and v.detected_at < t1 and (p_agent is null or a.id = p_agent)) x),

    -- Re-quarantine: agents switched back on outside the Control Tower and blocked again (task 4.7).
    'requarantine', (select jsonb_build_object('total', count(*), 'rows', coalesce(jsonb_agg(r order by (r ->> 'id')::bigint) filter (where n <= cap), '[]'))
      from (select row_number() over (order by e.id) n, jsonb_build_object(
              'id', e.id, 'agent', a.agent_code || ' ' || a.name, 'target', e.target, 'status', e.status, 'attempts', e.attempts,
              'detail', e.detail, 'created_at', e.created_at, 'finished_at', e.finished_at) r
              from public.agent_enforcements e join public.agents a on a.id = e.agent_id
             where e.created_at >= t0 and e.created_at < t1 and e.cause = 'reblock' and (p_agent is null or a.id = p_agent)) x),

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
        from public.platform_connections c where p_agent is null or c.id in (select connection_id from public.platform_agents where agent_id = p_agent)),
      'total', (select count(*) from public.platform_jobs j
                 where j.kind in ('sync', 'reconcile') and j.created_at >= t0 and j.created_at < t1 and public.evidence_sync_notable(j)
                   and (p_agent is null or j.connection_id in (select connection_id from public.platform_agents where agent_id = p_agent))),
      'rows', (select coalesce(jsonb_agg(r order by (r ->> 'id')::bigint), '[]') from (
                 select jsonb_build_object('id', j.id, 'platform', c.name, 'kind', j.kind, 'at', j.created_at,
                                           'ok', j.ok, 'message', j.message) r
                   from public.platform_jobs j join public.platform_connections c on c.id = j.connection_id
                  where j.kind in ('sync', 'reconcile') and j.created_at >= t0 and j.created_at < t1 and public.evidence_sync_notable(j)
                    and (p_agent is null or j.connection_id in (select connection_id from public.platform_agents where agent_id = p_agent))
                  order by j.id limit cap) x))
  );

  -- Attestation.
  select count(*) into chain_len from public.audit_events;
  select * into chain from public.audit_verify_chain() limit 1;
  select e.seq, e.occurred_at, e.hash into first_ev from public.audit_events e where e.occurred_at >= t0 and e.occurred_at < t1 and (p_agent is null or e.agent_id = p_agent) order by e.seq limit 1;
  select e.seq, e.occurred_at, e.hash into last_ev from public.audit_events e where e.occurred_at >= t0 and e.occurred_at < t1 and (p_agent is null or e.agent_id = p_agent) order by e.seq desc limit 1;
  digest := encode(sha256(convert_to(pack::text, 'UTF8')), 'hex');

  insert into public.audit_events (actor_id, actor_type, action, entity_type, summary, reason, after)
  values (auth.uid(), 'user', 'evidence_pack.generated', 'evidence_pack',
          format('Evidence pack %s to %s%s produced by %s', p_from, p_to,
                 case when ag.id is not null then format(' for %s %s', ag.agent_code, ag.name) else '' end, coalesce(me.full_name, 'someone')),
          null, jsonb_build_object('from', p_from, 'to', p_to, 'digest', digest)
                || case when ag.id is not null then jsonb_build_object('agent_id', ag.id, 'agent_code', ag.agent_code) else '{}'::jsonb end)
  returning audit_events.seq into pack_seq;

  return pack || jsonb_build_object('attestation', jsonb_build_object(
    'pack_seq', pack_seq,
    'digest', digest,
    'chain_intact', chain.broken_seq is null,
    'chain_broken_at', chain.broken_seq,
    'chain_length', chain_len,
    'period_events', (select count(*) from public.audit_events e where e.occurred_at >= t0 and e.occurred_at < t1 and (p_agent is null or e.agent_id = p_agent)),
    'period_first', case when first_ev.seq is not null then jsonb_build_object('seq', first_ev.seq, 'at', first_ev.occurred_at, 'hash', first_ev.hash) end,
    'period_last', case when last_ev.seq is not null then jsonb_build_object('seq', last_ev.seq, 'at', last_ev.occurred_at, 'hash', last_ev.hash) end,
    'latest_hash', (select hash from public.audit_events order by seq desc limit 1)));
end $$;

revoke execute on function public.evidence_pack(date, date, uuid) from public, anon;
grant execute on function public.evidence_pack(date, date, uuid) to authenticated;

-- Exporting the audit trail for one agent says so in the entry's summary.
create or replace function public.audit_record_export(p_filters jsonb, p_rows integer, p_format text) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  s bigint;
  ag text;
begin
  if not public.is_active_user() then
    raise exception 'Sign in to export the audit trail' using errcode = 'insufficient_privilege';
  end if;
  if p_format not in ('csv', 'json') then raise exception 'Unknown format' using errcode = 'invalid_parameter_value'; end if;
  if p_filters ->> 'agent' ~ '^[0-9a-f-]{36}$' then
    select a.agent_code || ' ' || a.name into ag from public.agents a where a.id = (p_filters ->> 'agent')::uuid;
  end if;
  insert into public.audit_events (actor_id, actor_type, action, entity_type, summary, after)
  values (auth.uid(), 'user', 'audit.exported', 'audit_events',
          format('Audit trail exported as %s: %s entries%s', upper(p_format), p_rows, case when ag is not null then ' for ' || ag else '' end),
          jsonb_build_object('filters', coalesce(p_filters, '{}'::jsonb), 'rows', p_rows, 'format', p_format))
  returning seq into s;
  return s;
end $$;
