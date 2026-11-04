-- Task 4.3: when stopping a suspended agent fails (R2.2). The agent stays Suspended whatever happens. A step that failed
-- stays "pending" and is tried again (after 1, 2, 5, 15 and 30 minutes, then every hour) until it works, while the agent is
-- still suspended. The admins are alerted once per agent ("enforcement pending", on the agent and on their phones); the
-- alert clears by itself when every step has worked, or when the agent is no longer suspended. A step the API says can
-- never work by retrying (for example an owner with no real mailbox) is marked failed and left to a person.

alter type public.alert_kind add value if not exists 'enforcement_pending';

alter table public.agent_enforcements add column next_attempt_at timestamptz not null default now();
alter table public.agent_enforcements drop constraint agent_enforcements_status_check;
alter table public.agent_enforcements add constraint agent_enforcements_status_check
  check (status in ('pending', 'done', 'failed', 'cancelled'));
drop index public.agent_enforcements_due;
create index agent_enforcements_due on public.agent_enforcements (next_attempt_at) where status = 'pending';

alter table public.push_outbox drop constraint push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check
  check (kind in ('action_request', 'test', 'agent_discovered', 'suspension', 'enforcement'));

create function public.enforcement_backoff(p_attempts integer) returns interval
language sql immutable set search_path = '' as $$
  select case p_attempts when 1 then interval '1 minute' when 2 then interval '2 minutes' when 3 then interval '5 minutes'
                         when 4 then interval '15 minutes' when 5 then interval '30 minutes' else interval '60 minutes' end
$$;

-- One "enforcement pending" alert per agent while any step has failed and not yet worked; cleared when none is left.
-- Raising it also sends each active admin one phone alert.
create function public.enforcement_alerts(p_agent uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  bad record;
  msg text;
  alert_id uuid;
begin
  select * into a from public.agents where id = p_agent;
  select e.target, e.detail, e.status, e.next_attempt_at into bad
    from public.agent_enforcements e
   where e.agent_id = p_agent and (e.status = 'failed' or (e.status = 'pending' and e.attempts > 0))
   order by (e.status = 'failed') desc, e.id limit 1;
  if not found or a.status <> 'suspended' then
    update public.alerts set resolved_at = now() where agent_id = p_agent and kind = 'enforcement_pending' and resolved_at is null;
    return;
  end if;
  msg := format('%s is suspended, but stopping it on %s has not worked yet: %s. %s', a.agent_code, bad.target, coalesce(rtrim(bad.detail, '. '), 'no answer'),
                case when bad.status = 'failed' then 'Trying again cannot fix this: a person needs to act.'
                     else format('Trying again at %s UTC.', to_char(bad.next_attempt_at at time zone 'UTC', 'HH24:MI')) end);
  update public.alerts set message = left(msg, 1000) where agent_id = p_agent and kind = 'enforcement_pending' and resolved_at is null;
  if found then return; end if;
  insert into public.alerts (kind, agent_id, message) values ('enforcement_pending', p_agent, left(msg, 1000))
  on conflict do nothing returning id into alert_id;
  if alert_id is not null then
    insert into public.push_outbox (user_id, kind, title, body, url)
    select p.id, 'enforcement', 'Not stopped yet · ' || a.agent_code, left(msg, 300), '/agents/' || a.id
      from public.profiles p
     where p.is_active and exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin');
  end if;
end $$;

-- No longer suspended (reactivated, retired): stop trying, and clear the alert.
create function public.agent_enforcement_cancel() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'suspended' and new.status <> 'suspended' then
    update public.agent_enforcements set status = 'cancelled', finished_at = now(),
           detail = left(coalesce(rtrim(detail, '. ') || '. ', '') || format('Stopped trying: the agent is now %s', new.status), 500)
     where agent_id = new.id and status = 'pending';
    perform public.enforcement_alerts(new.id);
  end if;
  return null;
end $$;
create trigger agent_enforcement_cancel after update of status on public.agents
  for each row execute function public.agent_enforcement_cancel();

-- The clock: every minute, ask our site to try again whatever is due.
create or replace function public.enforcement_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare
  url text;
  token text;
begin
  if not exists (select 1 from public.agent_enforcements
                  where status = 'pending' and next_attempt_at <= now()
                    and (claimed_at is null or claimed_at < now() - interval '2 minutes')) then
    return;
  end if;
  select site_url into url from public.push_config;
  if url is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
  token := public.new_secret('ent_');
  insert into public.enforcement_tokens (token_hash) values (public.secret_hash(token));
  execute 'select net.http_post(url := $1, body := $2, timeout_milliseconds := 5000)'
    using url || '/api/v1/enforce/run', jsonb_build_object('token', token);
end $$;

do $$
begin
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'enforcement-retry') then
      perform cron.unschedule('enforcement-retry');
    end if;
    perform cron.schedule('enforcement-retry', '* * * * *', 'select public.enforcement_kick()');
  end if;
end $$;

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
        'id', e.id, 'external_id', pa.external_id,
        'reason', format('Suspended in Agent Control Tower (%s): %s', a.agent_code, s.reason),
        'connection', jsonb_build_object('id', c.id, 'kind', c.kind, 'name', c.name, 'base_url', c.base_url,
                                         'secret', (select secret from public.platform_secrets where connection_id = c.id)))
        order by e.id), '[]'::jsonb)
      from public.agent_enforcements e
      join public.agents a on a.id = e.agent_id
      left join public.agent_suspensions s on s.id = e.suspension_id
      join public.platform_agents pa on pa.id = e.platform_agent_id
      join public.platform_connections c on c.id = pa.connection_id
     where e.id = any (ids) and e.method = 'platform'),
    'webhooks', (select coalesce(jsonb_agg(public.enforcement_webhook(e) order by e.id), '[]'::jsonb)
      from public.agent_enforcements e where e.id = any (ids) and e.method = 'webhook'),
    'emails', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'to_name', p.full_name, 'to_email', p.email, 'owner', a.business_owner_id = p.id,
        'agent', jsonb_build_object('id', a.id, 'code', a.agent_code, 'name', a.name,
                                    'department', (select name from public.departments where id = a.department_id),
                                    'systems', a.systems_accessed),
        'reason', s.reason, 'suspended_at', s.suspended_at,
        'suspended_by', (select full_name from public.profiles where id = s.requested_by)) order by e.id), '[]'::jsonb)
      from public.agent_enforcements e
      join public.agents a on a.id = e.agent_id
      join public.profiles p on p.id = e.user_id
      left join public.agent_suspensions s on s.id = e.suspension_id
     where e.id = any (ids) and e.method = 'email'),
    'email', case when cfg.email_api_key is not null then jsonb_build_object(
        'api_key', cfg.email_api_key,
        'from', coalesce(cfg.email_from, 'Agent Control Tower <onboarding@resend.dev>'),
        'redirect_to', cfg.email_redirect_to, 'site_url', cfg.site_url) end);
end $$;

-- p_results: [{"id", "ok", "detail", "retry"}]. A failed step stays pending and is tried again later (task 4.3), unless
-- the API says trying again cannot help ("retry": false, e.g. the owner has no real mailbox): then it is failed and needs
-- a person. Either way the admins are alerted, once per agent, until every step has worked.
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
        update public.platform_agents set status = 'blocked', status_seen_at = now() where id = e.platform_agent_id and status <> 'blocked';
      end if;
    end if;
  end loop;
  perform public.enforcement_alerts(a) from unnest(touched) a group by a;
  delete from public.enforcement_tokens where created_at < now() - interval '1 day';
  return n;
end $$;

revoke execute on function public.enforcement_backoff(integer), public.enforcement_alerts(uuid), public.agent_enforcement_cancel()
  from public, anon, authenticated;
