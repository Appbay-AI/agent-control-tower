-- Task 4.6: reactivation approval (R2.3). A suspended agent goes back to Live only through an approved request, never
-- a toggle. Someone who may suspend the agent asks, with a reason; an admin or an approver for the agent's department
-- who is not the asker approves (two different people for a Critical agent). Asking is refused while any incident on
-- the agent is still Open (it must be at least Contained). Only once approved does the agent go Live, and only then is
-- it switched back on everywhere it was stopped: unblocked on its platform and read back as active, its key answered
-- again, a signed "agent.resume" request sent to its control endpoint, or its owner told by email. Those steps use the
-- enforcement machinery of tasks 4.2 and 4.3 (action "restore"), so they are retried and alerted the same way.

-- ---------------------------------------------------------------------------
-- The requests and their approvals
-- ---------------------------------------------------------------------------
create table public.agent_reactivations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  suspension_id uuid references public.agent_suspensions (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  requested_by uuid not null references public.profiles (id),
  requested_at timestamptz not null default now(),
  required_approvals integer not null check (required_approvals in (1, 2)),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  decision_reason text check (length(decision_reason) <= 1000)
);
create unique index agent_reactivations_one_pending on public.agent_reactivations (agent_id) where status = 'pending';
create index agent_reactivations_agent on public.agent_reactivations (agent_id, requested_at desc);
alter table public.agent_reactivations enable row level security;
create policy "reactivations visible with the agent" on public.agent_reactivations for select to authenticated
  using (public.can_see_agent(agent_id));
revoke all on public.agent_reactivations from anon, authenticated;
grant select on public.agent_reactivations to authenticated;
create trigger audit_change after insert or update on public.agent_reactivations
  for each row execute function public.audit_table_change();

create table public.agent_reactivation_approvals (
  reactivation_id uuid not null references public.agent_reactivations (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  approver_id uuid not null references public.profiles (id),
  note text check (length(note) <= 1000),
  approved_at timestamptz not null default now(),
  primary key (reactivation_id, approver_id)
);
alter table public.agent_reactivation_approvals enable row level security;
create policy "reactivation approvals visible with the agent" on public.agent_reactivation_approvals for select to authenticated
  using (public.can_see_agent(agent_id));
revoke all on public.agent_reactivation_approvals from anon, authenticated;
grant select on public.agent_reactivation_approvals to authenticated;
create trigger audit_change after insert on public.agent_reactivation_approvals
  for each row execute function public.audit_table_change();

alter table public.push_outbox drop constraint push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check
  check (kind in ('action_request', 'test', 'agent_discovered', 'suspension', 'enforcement', 'incident', 'reactivation'));

-- Who may approve: admins, and approvers for the agent's department.
create function public.can_approve_reactivation(p_agent uuid, p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.agents a join public.profiles p on p.id = p_user and p.is_active
     where a.id = p_agent
       and (exists (select 1 from public.user_roles r where r.user_id = p_user and r.role = 'admin')
            or (exists (select 1 from public.user_roles r where r.user_id = p_user and r.role = 'approver')
                and exists (select 1 from public.approver_scopes s where s.user_id = p_user and s.department_id = a.department_id))))
$$;

-- ---------------------------------------------------------------------------
-- Ask
-- ---------------------------------------------------------------------------
create function public.request_reactivation(p_agent uuid, p_reason text) returns uuid
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

-- ---------------------------------------------------------------------------
-- Approve: the last approval needed switches the agent back on.
-- ---------------------------------------------------------------------------
create function public.approve_reactivation(p_reactivation uuid, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.agent_reactivations;
  a public.agents;
  n integer;
  names text;
begin
  select * into r from public.agent_reactivations where id = p_reactivation for update;
  if not found then raise exception 'No such request' using errcode = 'no_data_found'; end if;
  if r.status <> 'pending' then raise exception 'This request is already %', r.status using errcode = 'check_violation'; end if;
  if not public.can_approve_reactivation(r.agent_id) then
    raise exception 'Only admins and approvers for the agent''s department can approve switching it back on'
      using errcode = 'insufficient_privilege';
  end if;
  if r.requested_by = auth.uid() then
    raise exception 'Someone other than the person who asked must approve it' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.agent_reactivation_approvals where reactivation_id = r.id and approver_id = auth.uid()) then
    raise exception 'You have already approved it; a second person must approve too' using errcode = 'check_violation';
  end if;
  insert into public.agent_reactivation_approvals (reactivation_id, agent_id, approver_id, note)
  values (r.id, r.agent_id, auth.uid(), nullif(btrim(coalesce(p_note, '')), ''));
  select count(*) into n from public.agent_reactivation_approvals where reactivation_id = r.id;
  if n < r.required_approvals then return 'waiting'; end if;

  select * into a from public.agents where id = r.agent_id for update;
  if a.status <> 'suspended' then
    raise exception '% is %, not suspended', a.agent_code, a.status using errcode = 'check_violation';
  end if;
  select string_agg(p.full_name, ' and ' order by x.approved_at) into names
    from public.agent_reactivation_approvals x join public.profiles p on p.id = x.approver_id where x.reactivation_id = r.id;
  update public.agent_reactivations set status = 'approved', decided_by = auth.uid(), decided_at = now(),
         decision_reason = nullif(btrim(coalesce(p_note, '')), '')
   where id = r.id;
  perform public.begin_governed_change(format('Switched back on after approval by %s: %s', names, r.reason));
  update public.agents set status = 'live' where id = a.id;
  perform public.end_governed_change();

  -- On the record of every incident still being worked on.
  insert into public.incident_updates (incident_id, agent_id, kind, body, author_id)
  select i.id, i.agent_id, 'note', format('%s switched back on after approval by %s: %s', a.agent_code, names, r.reason), auth.uid()
    from public.incidents i where i.agent_id = a.id and i.status in ('open', 'contained');

  if r.requested_by <> auth.uid() then
    insert into public.push_outbox (user_id, kind, title, body, url)
    values (r.requested_by, 'reactivation', format('Switched back on · %s', a.agent_code),
            left(format('%s approved switching %s back on.', names, a.name), 300), '/agents/' || a.id);
  end if;
  return 'approved';
end $$;

create function public.reject_reactivation(p_reactivation uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.agent_reactivations;
  code text;
begin
  select * into r from public.agent_reactivations where id = p_reactivation for update;
  if not found then raise exception 'No such request' using errcode = 'no_data_found'; end if;
  if r.status <> 'pending' then raise exception 'This request is already %', r.status using errcode = 'check_violation'; end if;
  if not public.can_approve_reactivation(r.agent_id) then
    raise exception 'Only admins and approvers for the agent''s department can reject it' using errcode = 'insufficient_privilege';
  end if;
  if r.requested_by = auth.uid() then
    raise exception 'Withdraw your own request instead' using errcode = 'insufficient_privilege';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'Say why it stays suspended' using errcode = 'check_violation'; end if;
  update public.agent_reactivations set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_reason = btrim(p_reason)
   where id = r.id;
  select agent_code into code from public.agents where id = r.agent_id;
  insert into public.push_outbox (user_id, kind, title, body, url)
  values (r.requested_by, 'reactivation', format('Stays suspended · %s', code),
          left(format('%s rejected switching it back on: %s', (select full_name from public.profiles where id = auth.uid()), btrim(p_reason)), 300),
          '/agents/' || r.agent_id);
end $$;

create function public.withdraw_reactivation(p_reactivation uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.agent_reactivations;
begin
  select * into r from public.agent_reactivations where id = p_reactivation for update;
  if not found then raise exception 'No such request' using errcode = 'no_data_found'; end if;
  if r.status <> 'pending' then raise exception 'This request is already %', r.status using errcode = 'check_violation'; end if;
  if r.requested_by <> auth.uid() and not public.has_role('admin') then
    raise exception 'Only the person who asked, or an admin, can withdraw it' using errcode = 'insufficient_privilege';
  end if;
  update public.agent_reactivations set status = 'withdrawn', decided_by = auth.uid(), decided_at = now(),
         decision_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = r.id;
end $$;

-- A request left waiting when the agent stops being suspended some other way (retired) is withdrawn.
create function public.agent_reactivations_close() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'suspended' and new.status not in ('suspended', 'live') then
    update public.agent_reactivations set status = 'withdrawn', decided_at = now(),
           decision_reason = format('The agent was %s', new.status)
     where agent_id = new.id and status = 'pending';
  end if;
  return null;
end $$;
create trigger agent_reactivations_close after update of status on public.agents
  for each row execute function public.agent_reactivations_close();

-- ---------------------------------------------------------------------------
-- Switching it back on everywhere: enforcement steps with action "restore"
-- ---------------------------------------------------------------------------
alter table public.agent_enforcements
  add column action text not null default 'stop' check (action in ('stop', 'restore')),
  add column reactivation_id uuid references public.agent_reactivations (id) on delete set null;

create function public.agent_restore_plan() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r_id uuid;
  reachable boolean := false;
begin
  if not (old.status = 'suspended' and new.status = 'live') then return null; end if;
  select id into r_id from public.agent_reactivations where agent_id = new.id and status = 'approved' order by decided_at desc limit 1;

  insert into public.agent_enforcements (agent_id, reactivation_id, action, method, target, platform_agent_id)
  select new.id, r_id, 'restore', 'platform', format('%s as %s', c.name, pa.external_id), pa.id
    from public.platform_agents pa join public.platform_connections c on c.id = pa.connection_id
   where pa.agent_id = new.id and pa.missing_since is null;
  if found then reachable := true; end if;

  if exists (select 1 from public.agent_api_keys where agent_id = new.id and revoked_at is null) then
    insert into public.agent_enforcements (agent_id, reactivation_id, action, method, target, status, detail, finished_at)
    values (new.id, r_id, 'restore', 'api', 'Its API key', 'done', 'Answered again: its checks and requests are handled normally', now());
    reachable := true;
  end if;

  if new.control_endpoint is not null and new.control_endpoint ~ '^https://' then
    insert into public.agent_enforcements (agent_id, reactivation_id, action, method, target)
    values (new.id, r_id, 'restore', 'webhook', new.control_endpoint);
    reachable := true;
  end if;

  if not reachable then
    insert into public.agent_enforcements (agent_id, reactivation_id, action, method, target, user_id)
    select new.id, r_id, 'restore', 'email', format('%s (%s)', p.full_name, coalesce(p.email, 'no email')), p.id
      from public.profiles p
     where p.is_active and (p.id = new.business_owner_id
            or (new.business_owner_id is null and exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin')));
  end if;

  perform public.enforcement_kick();
  return null;
end $$;
create trigger agent_restore_plan after update of status on public.agents
  for each row execute function public.agent_restore_plan();

-- Stop steps end when the agent is no longer suspended; restore steps end when it is no longer live.
create or replace function public.agent_enforcement_cancel() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status is distinct from new.status then
    update public.agent_enforcements set status = 'cancelled', finished_at = now(),
           detail = left(coalesce(rtrim(detail, '. ') || '. ', '') || format('Stopped trying: the agent is now %s', new.status), 500)
     where agent_id = new.id and status = 'pending'
       and ((action = 'stop' and new.status <> 'suspended') or (action = 'restore' and new.status <> 'live'));
    perform public.enforcement_alerts(new.id);
  end if;
  return null;
end $$;

-- One alert per agent while a step that matches its state has failed and not yet worked (stopping it while suspended,
-- switching it back on while live). Raising it also sends each active admin one phone alert.
create or replace function public.enforcement_alerts(p_agent uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  want text;
  bad record;
  msg text;
  alert_id uuid;
begin
  select * into a from public.agents where id = p_agent;
  want := case a.status when 'suspended' then 'stop' when 'live' then 'restore' end;
  select e.target, e.detail, e.status, e.next_attempt_at into bad
    from public.agent_enforcements e
   where e.agent_id = p_agent and e.action = want and (e.status = 'failed' or (e.status = 'pending' and e.attempts > 0))
   order by (e.status = 'failed') desc, e.id limit 1;
  if not found or want is null then
    update public.alerts set resolved_at = now() where agent_id = p_agent and kind = 'enforcement_pending' and resolved_at is null;
    return;
  end if;
  msg := format(case want when 'stop' then '%s is suspended, but stopping it on %s has not worked yet: %s. %s'
                     else '%s was approved to run again, but switching it back on at %s has not worked yet: %s. %s' end,
                a.agent_code, bad.target, coalesce(rtrim(bad.detail, '. '), 'no answer'),
                case when bad.status = 'failed' then 'Trying again cannot fix this: a person needs to act.'
                     else format('Trying again at %s UTC.', to_char(bad.next_attempt_at at time zone 'UTC', 'HH24:MI')) end);
  update public.alerts set message = left(msg, 1000) where agent_id = p_agent and kind = 'enforcement_pending' and resolved_at is null;
  if found then return; end if;
  insert into public.alerts (kind, agent_id, message) values ('enforcement_pending', p_agent, left(msg, 1000))
  on conflict do nothing returning id into alert_id;
  if alert_id is not null then
    insert into public.push_outbox (user_id, kind, title, body, url)
    select p.id, 'enforcement', case want when 'stop' then 'Not stopped yet · ' else 'Not switched back on yet · ' end || a.agent_code,
           left(msg, 300), '/agents/' || a.id
      from public.profiles p
     where p.is_active and exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin');
  end if;
end $$;

-- The signed request for the agent's control endpoint: "agent.stop" or "agent.resume".
create or replace function public.enforcement_webhook(e public.agent_enforcements) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a public.agents;
  s public.agent_suspensions;
  rr public.agent_reactivations;
  secret text;
  body text;
  ev text := case e.action when 'restore' then 'agent.resume' else 'agent.stop' end;
  t text := floor(extract(epoch from now()))::bigint::text;
begin
  select * into a from public.agents where id = e.agent_id;
  select key_hash into secret from public.agent_api_keys where agent_id = a.id and revoked_at is null order by created_at desc limit 1;
  if e.action = 'restore' then
    select * into rr from public.agent_reactivations where id = e.reactivation_id;
    body := jsonb_build_object('event', ev, 'delivery_id', e.id, 'agent_id', a.id, 'agent_code', a.agent_code,
                               'status', a.status, 'reason', rr.reason, 'approved_at', rr.decided_at, 'sent_at', now())::text;
  else
    select * into s from public.agent_suspensions where id = e.suspension_id;
    body := jsonb_build_object('event', ev, 'delivery_id', e.id, 'agent_id', a.id, 'agent_code', a.agent_code,
                               'status', a.status, 'reason', s.reason, 'suspended_at', s.suspended_at, 'sent_at', now())::text;
  end if;
  return jsonb_build_object('id', e.id, 'url', e.target, 'body', body, 'request_id', '', 'event', ev,
    'signature', case when secret is null then null
                      else 't=' || t || ',v1=' || encode(extensions.hmac(t || '.' || body, secret, 'sha256'), 'hex') end);
end $$;

-- The work for our API now says, for each platform step and email, whether to stop or restore.
create or replace function public.enforcement_claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ids bigint[];
  cfg public.push_config;
begin
  perform public.enforcement_use_token(p_token, 'claim');
  select array_agg(id) into ids from (
    select id from public.agent_enforcements
     where status = 'pending' and next_attempt_at <= now()
       and (claimed_at is null or claimed_at < now() - interval '2 minutes')
     order by id limit 20 for update skip locked) due;
  if ids is null then return jsonb_build_object('platform', '[]'::jsonb, 'webhooks', '[]'::jsonb, 'emails', '[]'::jsonb); end if;
  update public.agent_enforcements set claimed_at = now(), attempts = attempts + 1 where id = any (ids);
  select * into cfg from public.push_config;

  return jsonb_build_object(
    'platform', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'action', e.action, 'external_id', pa.external_id,
        'reason', case e.action
                    when 'restore' then format('Switched back on in Agent Control Tower (%s) after approval: %s', a.agent_code, rr.reason)
                    else format('Suspended in Agent Control Tower (%s): %s', a.agent_code, s.reason) end,
        'connection', jsonb_build_object('id', c.id, 'kind', c.kind, 'name', c.name, 'base_url', c.base_url,
                                         'secret', (select secret from public.platform_secrets where connection_id = c.id)))
        order by e.id), '[]'::jsonb)
      from public.agent_enforcements e
      join public.agents a on a.id = e.agent_id
      left join public.agent_suspensions s on s.id = e.suspension_id
      left join public.agent_reactivations rr on rr.id = e.reactivation_id
      join public.platform_agents pa on pa.id = e.platform_agent_id
      join public.platform_connections c on c.id = pa.connection_id
     where e.id = any (ids) and e.method = 'platform'),
    'webhooks', (select coalesce(jsonb_agg(public.enforcement_webhook(e) order by e.id), '[]'::jsonb)
      from public.agent_enforcements e where e.id = any (ids) and e.method = 'webhook'),
    'emails', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'action', e.action, 'to_name', p.full_name, 'to_email', p.email, 'owner', a.business_owner_id = p.id,
        'agent', jsonb_build_object('id', a.id, 'code', a.agent_code, 'name', a.name,
                                    'department', (select name from public.departments where id = a.department_id),
                                    'systems', a.systems_accessed),
        'reason', case e.action when 'restore' then rr.reason else s.reason end,
        'suspended_at', case e.action when 'restore' then rr.decided_at else s.suspended_at end,
        'suspended_by', case e.action
                          when 'restore' then (select string_agg(pp.full_name, ' and ' order by x.approved_at)
                                                 from public.agent_reactivation_approvals x join public.profiles pp on pp.id = x.approver_id
                                                where x.reactivation_id = rr.id)
                          else (select full_name from public.profiles where id = s.requested_by) end) order by e.id), '[]'::jsonb)
      from public.agent_enforcements e
      join public.agents a on a.id = e.agent_id
      join public.profiles p on p.id = e.user_id
      left join public.agent_suspensions s on s.id = e.suspension_id
      left join public.agent_reactivations rr on rr.id = e.reactivation_id
     where e.id = any (ids) and e.method = 'email'),
    'email', case when cfg.email_api_key is not null then jsonb_build_object(
        'api_key', cfg.email_api_key,
        'from', coalesce(cfg.email_from, 'Agent Control Tower <onboarding@resend.dev>'),
        'redirect_to', cfg.email_redirect_to, 'site_url', cfg.site_url) end);
end $$;

-- A done restore on a platform marks the platform record active again.
create or replace function public.enforcement_report(p_token text, p_results jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb;
  e public.agent_enforcements;
  ok boolean;
  n integer := 0;
  touched uuid[] := '{}';
begin
  perform public.enforcement_use_token(p_token, 'report');
  if jsonb_typeof(p_results) is distinct from 'array' then
    raise exception 'results must be a list' using errcode = 'check_violation';
  end if;
  for r in select value from jsonb_array_elements(p_results) loop
    ok := coalesce((r ->> 'ok')::boolean, false);
    update public.agent_enforcements
       set status = case when ok then 'done' when coalesce((r ->> 'retry')::boolean, true) then 'pending' else 'failed' end,
           detail = left(coalesce(nullif(r ->> 'detail', ''), case when ok then 'Done' else 'Failed' end), 500),
           finished_at = case when ok or not coalesce((r ->> 'retry')::boolean, true) then now() end,
           claimed_at = case when ok then claimed_at end,
           next_attempt_at = case when ok then next_attempt_at else now() + public.enforcement_backoff(attempts) end
     where id = (r ->> 'id')::bigint and status = 'pending' and claimed_at is not null
    returning * into e;
    if found then
      n := n + 1;
      touched := touched || e.agent_id;
      if e.method = 'platform' and e.status = 'done' then
        update public.platform_agents set status = case e.action when 'restore' then 'active' else 'blocked' end, status_seen_at = now()
         where id = e.platform_agent_id and status <> case e.action when 'restore' then 'active' else 'blocked' end;
      end if;
    end if;
  end loop;
  perform public.enforcement_alerts(a) from unnest(touched) a group by a;
  delete from public.enforcement_tokens where created_at < now() - interval '1 day';
  return n;
end $$;

revoke execute on function public.agent_restore_plan(), public.agent_reactivations_close() from public, anon, authenticated;
revoke execute on function public.can_approve_reactivation(uuid, uuid), public.request_reactivation(uuid, text),
  public.approve_reactivation(uuid, text), public.reject_reactivation(uuid, text), public.withdraw_reactivation(uuid, text) from public, anon;
grant execute on function public.can_approve_reactivation(uuid, uuid), public.request_reactivation(uuid, text),
  public.approve_reactivation(uuid, text), public.reject_reactivation(uuid, text), public.withdraw_reactivation(uuid, text) to authenticated;
