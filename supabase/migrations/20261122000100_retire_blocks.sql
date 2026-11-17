-- Task 5.5 (added 13 Nov): retiring an agent also blocks it on its platform (Appian), read back as blocked, with the same
-- retries and admin alerts as the kill switch (tasks 4.2, 4.3). Before this, retiring only changed the registry.
-- A step is planned for each platform record linked to the agent that is still listed there and has no stop step under
-- way already (a suspended agent that is retired keeps its suspension's step; it is no longer cancelled).

alter table public.agent_enforcements drop constraint agent_enforcements_cause_check;
alter table public.agent_enforcements add constraint agent_enforcements_cause_check
  check (cause in ('suspension', 'reblock', 'retirement'));
-- Why this step exists, in words, when it is not a suspension's or a reactivation's (the retirement's reason).
alter table public.agent_enforcements add column reason text check (length(reason) <= 1000);

create function public.agent_retire_plan() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not (new.status = 'retired' and old.status is distinct from 'retired') then return null; end if;
  insert into public.agent_enforcements (agent_id, action, cause, method, target, platform_agent_id, reason)
  select new.id, 'stop', 'retirement', 'platform', format('%s as %s', c.name, pa.external_id), pa.id,
         left(coalesce(nullif(current_setting('act.reason', true), ''), 'Retired'), 1000)
    from public.platform_agents pa join public.platform_connections c on c.id = pa.connection_id
   where pa.agent_id = new.id and pa.missing_since is null
     and not exists (select 1 from public.agent_enforcements e
                      where e.platform_agent_id = pa.id and e.action = 'stop' and e.status = 'pending');
  get diagnostics n = row_count;
  if n > 0 then perform public.enforcement_kick(); end if;
  return null;
end $$;
-- Named to run after agent_enforcement_cancel (triggers run in name order).
create trigger agent_retire_plan after update of status on public.agents
  for each row execute function public.agent_retire_plan();

-- Stop steps carry on for a retired agent (they are cancelled only when it goes back to Live or is Approved again).
create or replace function public.agent_enforcement_cancel() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status is distinct from new.status then
    update public.agent_enforcements set status = 'cancelled', finished_at = now(),
           detail = left(coalesce(rtrim(detail, '. ') || '. ', '') || format('Stopped trying: the agent is now %s', new.status), 500)
     where agent_id = new.id and status = 'pending'
       and ((action = 'stop' and new.status not in ('suspended', 'retired')) or (action = 'restore' and new.status <> 'live'));
    perform public.enforcement_alerts(new.id);
  end if;
  return null;
end $$;

-- The "not stopped yet" alert (task 4.3) also for a retired agent.
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
  want := case a.status when 'suspended' then 'stop' when 'retired' then 'stop' when 'live' then 'restore' end;
  select e.target, e.detail, e.status, e.next_attempt_at into bad
    from public.agent_enforcements e
   where e.agent_id = p_agent and e.action = want and (e.status = 'failed' or (e.status = 'pending' and e.attempts > 0))
   order by (e.status = 'failed') desc, e.id limit 1;
  if not found or want is null then
    update public.alerts set resolved_at = now() where agent_id = p_agent and kind = 'enforcement_pending' and resolved_at is null;
    return;
  end if;
  msg := format(case when want = 'restore' then '%s was approved to run again, but switching it back on at %s has not worked yet: %s. %s'
                     when a.status = 'retired' then '%s is retired, but blocking it on %s has not worked yet: %s. %s'
                     else '%s is suspended, but stopping it on %s has not worked yet: %s. %s' end,
                a.agent_code, bad.target, coalesce(rtrim(bad.detail, '. '), 'no answer'),
                case when bad.status = 'failed' then 'Trying again cannot fix this: a person needs to act.'
                     else format('Trying again at %s UTC.', to_char(bad.next_attempt_at at time zone 'UTC', 'HH24:MI')) end);
  update public.alerts set message = left(msg, 1000) where agent_id = p_agent and kind = 'enforcement_pending' and resolved_at is null;
  if found then return; end if;
  insert into public.alerts (kind, agent_id, message) values ('enforcement_pending', p_agent, left(msg, 1000))
  on conflict do nothing returning id into alert_id;
  -- (Phone alerts for this alert follow the alert routes since task 5.4.)
end $$;

-- What the platform is told: "Retired in Agent Control Tower (AGT-…): <reason>" for a retirement's step.
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
        'reason', case
                    when e.action = 'restore' then format('Switched back on in Agent Control Tower (%s) after approval: %s', a.agent_code, rr.reason)
                    when e.cause = 'retirement' then format('Retired in Agent Control Tower (%s): %s', a.agent_code, e.reason)
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

-- The alert email for "not stopped yet" (task 5.1) names a retirement too.
create or replace function public.alerts_alert_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  pa record;
begin
  if new.kind not in ('enforcement_pending', 'agent_discovered') or new.agent_id is null then return null; end if;
  select * into a from public.agents where id = new.agent_id;
  if new.kind = 'enforcement_pending' then
    perform public.alert_email(a.id, 'enforcement_pending',
      case a.status when 'suspended' then format('%s %s is suspended but not stopped everywhere yet', a.agent_code, a.name)
                    when 'retired' then format('%s %s is retired but not blocked on its platform yet', a.agent_code, a.name)
                    else format('%s %s is approved to run but not switched back on everywhere yet', a.agent_code, a.name) end,
      public.alert_facts('What has not worked', new.message,
                         'What happens now', case when new.message like '%a person needs to act%'
                                                  then 'Trying again cannot fix this: a person needs to act.'
                                                  else 'The Control Tower keeps trying (after 1, 2, 5, 15 and 30 minutes, then hourly) and the alert clears itself once it works.' end),
      'pending:' || new.id);
  else
    select c.name platform, x.external_id, coalesce(x.details -> 'owner' ->> 'name', x.details -> 'owner' ->> 'email') owner
      into pa
      from public.platform_agents x join public.platform_connections c on c.id = x.connection_id
     where x.agent_id = a.id limit 1;
    perform public.alert_email(a.id, 'discovered',
      format('New agent found on %s: %s, not registered', coalesce(pa.platform, 'an agent platform'), a.name),
      public.alert_facts('Found as', case when pa.external_id is not null then format('%s on %s', pa.external_id, pa.platform) end,
                         'Owner on the platform', coalesce(pa.owner, 'Nobody'),
                         'In Control Tower', format('%s, Proposed: it cannot go live until an owner registers it and an approver approves it', a.agent_code),
                         'What to do', 'Name a business owner, write its purpose and submit it for approval, or retire it.'),
      'discovered:' || new.id);
  end if;
  return null;
end $$;

revoke execute on function public.agent_retire_plan() from public, anon, authenticated;
