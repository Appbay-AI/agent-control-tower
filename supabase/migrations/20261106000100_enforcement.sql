-- Task 4.2: enforcement by source (R2.1, R2.4). When an agent is suspended (the kill switch, task 4.1), the Control
-- Tower stops it every way it can, and records each one in agent_enforcements:
--   platform  the agent is on a connected platform: blocked there through the plug-in, then read back (it counts only
--             when the platform says it is blocked);
--   api       the agent has a key: every call it makes is refused from that moment (no message to send, done at once);
--   webhook   the agent has a control endpoint: a signed stop request is posted to it;
--   email     none of the above, so we cannot reach it: its business owner (or every admin, if it has none) is emailed
--             and asked to switch it off.
-- The work is done by our API (POST /api/v1/enforce/run), handed over with a one-time token like phone alerts. Each step
-- is tried once here; retrying failed steps and alerting admins is task 4.3.

create table public.agent_enforcements (
  id bigint generated always as identity primary key,
  agent_id uuid not null references public.agents (id) on delete cascade,
  suspension_id uuid references public.agent_suspensions (id) on delete set null,
  method text not null check (method in ('platform', 'api', 'webhook', 'email')),
  target text not null,                       -- what it acts on, in words: "Northbridge Agent Platform (simulated) as NAP-001"
  platform_agent_id uuid references public.platform_agents (id) on delete set null,
  user_id uuid references public.profiles (id) on delete set null,    -- who is emailed
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  detail text check (length(detail) <= 500),  -- what happened, in words
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);
create index agent_enforcements_agent on public.agent_enforcements (agent_id, id desc);
create index agent_enforcements_due on public.agent_enforcements (id) where status = 'pending';
alter table public.agent_enforcements enable row level security;
create policy "enforcement visible with the agent" on public.agent_enforcements for select to authenticated
  using (public.can_see_agent(agent_id));
revoke all on public.agent_enforcements from anon, authenticated;
grant select on public.agent_enforcements to authenticated;

create table public.enforcement_tokens (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  reported_at timestamptz
);
alter table public.enforcement_tokens enable row level security; -- functions only

-- ---------------------------------------------------------------------------
-- Planning: when an agent becomes Suspended, decide how to stop it.
-- ---------------------------------------------------------------------------
create function public.agent_enforcement_plan() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  s_id uuid;
  reachable boolean := false;
  owner_email text;
begin
  if not (old.status = 'live' and new.status = 'suspended') then return null; end if;
  select id into s_id from public.agent_suspensions where agent_id = new.id and status = 'done' order by suspended_at desc nulls last limit 1;

  -- On a platform: block it there.
  insert into public.agent_enforcements (agent_id, suspension_id, method, target, platform_agent_id)
  select new.id, s_id, 'platform', format('%s as %s', c.name, pa.external_id), pa.id
    from public.platform_agents pa join public.platform_connections c on c.id = pa.connection_id
   where pa.agent_id = new.id and pa.missing_since is null;
  if found then reachable := true; end if;

  -- Calls our API: refused from now on.
  if exists (select 1 from public.agent_api_keys where agent_id = new.id and revoked_at is null) then
    insert into public.agent_enforcements (agent_id, suspension_id, method, target, status, detail, finished_at)
    values (new.id, s_id, 'api', 'Its API key', 'done', 'Refused from now on: every check and request it makes with its key', now());
    reachable := true;
  end if;

  -- Has a control endpoint: send it a stop request.
  if new.control_endpoint is not null and new.control_endpoint ~ '^https://' then
    insert into public.agent_enforcements (agent_id, suspension_id, method, target)
    values (new.id, s_id, 'webhook', new.control_endpoint);
    reachable := true;
  end if;

  -- None of these: ask its owner (or, with no owner, every admin) to switch it off.
  if not reachable then
    insert into public.agent_enforcements (agent_id, suspension_id, method, target, user_id)
    select new.id, s_id, 'email', format('%s (%s)', p.full_name, coalesce(p.email, 'no email')), p.id
      from public.profiles p
     where p.is_active and (p.id = new.business_owner_id
            or (new.business_owner_id is null and exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin')));
  end if;

  perform public.enforcement_kick();
  return null;
end $$;

-- Asks our site to do the pending work (pg_net posts a one-time token after the transaction commits).
create function public.enforcement_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare
  url text;
  token text;
begin
  if not exists (select 1 from public.agent_enforcements where status = 'pending') then return; end if;
  select site_url into url from public.push_config;
  if url is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
  token := public.new_secret('ent_');
  insert into public.enforcement_tokens (token_hash) values (public.secret_hash(token));
  execute 'select net.http_post(url := $1, body := $2, timeout_milliseconds := 5000)'
    using url || '/api/v1/enforce/run', jsonb_build_object('token', token);
end $$;

create trigger agent_enforcement_plan after update of status on public.agents
  for each row execute function public.agent_enforcement_plan();

-- ---------------------------------------------------------------------------
-- The API's side (role anon, with the token): claim the work, then report what happened.
-- ---------------------------------------------------------------------------
create function public.enforcement_use_token(p_token text, p_step text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.enforcement_tokens;
begin
  select * into t from public.enforcement_tokens where token_hash = public.secret_hash(coalesce(p_token, '')) for update;
  if not found or t.created_at < now() - interval '10 minutes'
     or (p_step = 'claim' and t.claimed_at is not null)
     or (p_step = 'report' and (t.claimed_at is null or t.reported_at is not null)) then
    raise exception 'Invalid or used enforcement token' using errcode = 'invalid_authorization_specification';
  end if;
  if p_step = 'claim' then
    update public.enforcement_tokens set claimed_at = now() where token_hash = t.token_hash;
  else
    update public.enforcement_tokens set reported_at = now() where token_hash = t.token_hash;
  end if;
end $$;

-- The signed stop request for an agent's control endpoint. Signed like decision callbacks (task 2.8): HMAC-SHA256 with
-- the hash of the agent's newest active key, so the agent can tell it is genuine. No key: sent unsigned.
create function public.enforcement_webhook(e public.agent_enforcements) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a public.agents;
  s public.agent_suspensions;
  secret text;
  body text;
  t text := floor(extract(epoch from now()))::bigint::text;
begin
  select * into a from public.agents where id = e.agent_id;
  select * into s from public.agent_suspensions where id = e.suspension_id;
  select key_hash into secret from public.agent_api_keys where agent_id = a.id and revoked_at is null order by created_at desc limit 1;
  body := jsonb_build_object('event', 'agent.stop', 'delivery_id', e.id, 'agent_id', a.id, 'agent_code', a.agent_code,
                             'status', a.status, 'reason', s.reason, 'suspended_at', s.suspended_at, 'sent_at', now())::text;
  return jsonb_build_object('id', e.id, 'url', e.target, 'body', body, 'request_id', '', 'event', 'agent.stop',
    'signature', case when secret is null then null
                      else 't=' || t || ',v1=' || encode(extensions.hmac(t || '.' || body, secret, 'sha256'), 'hex') end);
end $$;

create function public.enforcement_claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ids bigint[];
  cfg public.push_config;
begin
  perform public.enforcement_use_token(p_token, 'claim');
  select array_agg(id) into ids from (
    select id from public.agent_enforcements
     where status = 'pending' and (claimed_at is null or claimed_at < now() - interval '2 minutes')
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

-- p_results: [{"id", "ok", "detail"}]. A platform block counts only when it was read back as blocked.
create function public.enforcement_report(p_token text, p_results jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb;
  e public.agent_enforcements;
  n integer := 0;
begin
  perform public.enforcement_use_token(p_token, 'report');
  if jsonb_typeof(p_results) is distinct from 'array' then
    raise exception 'results must be a list' using errcode = 'check_violation';
  end if;
  for r in select value from jsonb_array_elements(p_results) loop
    update public.agent_enforcements
       set status = case when (r ->> 'ok')::boolean then 'done' else 'failed' end,
           detail = left(coalesce(nullif(r ->> 'detail', ''), case when (r ->> 'ok')::boolean then 'Done' else 'Failed' end), 500),
           finished_at = now()
     where id = (r ->> 'id')::bigint and status = 'pending' and claimed_at is not null
    returning * into e;
    if found then
      n := n + 1;
      if e.method = 'platform' and e.status = 'done' then
        update public.platform_agents set status = 'blocked', status_seen_at = now() where id = e.platform_agent_id and status <> 'blocked';
      end if;
    end if;
  end loop;
  delete from public.enforcement_tokens where created_at < now() - interval '1 day';
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on function public.agent_enforcement_plan(), public.enforcement_kick(), public.enforcement_use_token(text, text),
  public.enforcement_webhook(public.agent_enforcements), public.enforcement_claim(text), public.enforcement_report(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.enforcement_claim(text), public.enforcement_report(text, jsonb) to anon;
