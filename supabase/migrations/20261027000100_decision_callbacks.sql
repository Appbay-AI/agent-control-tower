-- Phase 2, task 2.8: the decision goes back to the agent. Agents could already ask for it (GET /api/v1/actions/{id});
-- now, when a person decides a request that waited, the Control Tower also calls the agent's callback_url with the
-- decision, signed so the agent can tell it is genuine. Same queue-and-dispatch path as alerts and emails (2.6, 2.7).
--
-- Signature (header "ACT-Signature: t=<unix seconds>,v1=<hex>"):
--   v1 = HMAC-SHA256( key = the hex SHA-256 of the agent key that made the request,
--                     message = "<t>." + the exact request body )
-- The agent already knows its key, so there is no new secret to hand out. The database signs (pgcrypto); the secret
-- never leaves it. Agents should reject a signature older than 5 minutes, and still check may_proceed.
--
-- Also: an "agent console" for demos (admins): it plays the Payment Release Assistant, asks for a payment with a
-- callback to our own /api/v1/demo-agent/callback, and shows what the agent heard back and whether the signature held.

-- ---------------------------------------------------------------------------
-- Which key made each request (to sign its callback)
-- ---------------------------------------------------------------------------
alter table public.action_requests add column api_key_id uuid references public.agent_api_keys (id) on delete set null;

create or replace function public.agent_for_key(p_agent_key text) returns public.agents
language plpgsql security definer set search_path = '' as $$
declare
  k public.agent_api_keys;
  a public.agents;
begin
  select * into k from public.agent_api_keys
  where key_hash = public.secret_hash(coalesce(p_agent_key, '')) and revoked_at is null;
  if not found then raise exception 'Invalid or revoked agent key' using errcode = 'invalid_authorization_specification'; end if;
  update public.agent_api_keys set last_used_at = now() where id = k.id;
  perform set_config('act.api_key_id', k.id::text, true); -- read by action_requests_key below (task 2.8)
  select * into a from public.agents where id = k.agent_id;
  return a;
end $$;

create function public.action_requests_key() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.api_key_id := coalesce(new.api_key_id, nullif(current_setting('act.api_key_id', true), '')::uuid);
  return new;
end $$;
create trigger action_requests_key before insert on public.action_requests
  for each row execute function public.action_requests_key();

-- ---------------------------------------------------------------------------
-- Callback queue
-- ---------------------------------------------------------------------------
create table public.callback_outbox (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.action_requests (id) on delete cascade,
  url text not null check (url ~ '^https://'),
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  attempts integer not null default 0,
  sent_at timestamptz,          -- finished: delivered, or given up
  http_status integer,
  result text
);
create index callback_outbox_due on public.callback_outbox (next_attempt_at) where sent_at is null;
alter table public.callback_outbox enable row level security; -- functions only

-- When a request that waited is decided (or cancelled), queue its callback.
create function public.action_requests_callback() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'pending' and new.status <> 'pending' and new.callback_url is not null then
    insert into public.callback_outbox (request_id, url) values (new.id, new.callback_url);
  end if;
  return null;
end $$;
create trigger action_requests_callback after update of status on public.action_requests
  for each row execute function public.action_requests_callback();
create trigger callback_outbox_kick after insert on public.callback_outbox
  referencing new table as queued for each statement execute function public.push_outbox_kick();

-- Retries back off: 1, 2, 5, 15 and 60 minutes; 6 tries in all (about an hour and a half).
create function public.callback_backoff(p_attempts integer) returns interval
language sql immutable set search_path = '' as $$
  select case p_attempts when 1 then interval '1 minute' when 2 then interval '2 minutes' when 3 then interval '5 minutes'
                         when 4 then interval '15 minutes' else interval '60 minutes' end
$$;

-- The callback body and its signature, made in the database so the signing secret never leaves it.
create function public.callback_signed(c public.callback_outbox) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.action_requests;
  secret text;
  body text;
  t text := floor(extract(epoch from now()))::bigint::text;
begin
  select * into r from public.action_requests where id = c.request_id;
  select key_hash into secret from public.agent_api_keys where id = r.api_key_id;
  if secret is null then return null; end if;
  body := (public.action_request_json(r, false) - 'duplicate'
           || jsonb_build_object('event', 'action.decided', 'delivery_id', c.id, 'sent_at', now()))::text;
  return jsonb_build_object('id', c.id, 'url', c.url, 'body', body, 'request_id', r.id,
    'signature', 't=' || t || ',v1=' || encode(extensions.hmac(t || '.' || body, secret, 'sha256'), 'hex'));
end $$;

-- ---------------------------------------------------------------------------
-- The sender's claim and report, now with callbacks. The task 2.6/2.7 versions keep their job under a new name.
-- ---------------------------------------------------------------------------
alter function public.push_claim(text) rename to push_claim_alerts_and_emails;
alter function public.push_report(text, jsonb) rename to push_report_alerts_and_emails;
revoke execute on function public.push_claim_alerts_and_emails(text), public.push_report_alerts_and_emails(text, jsonb)
  from public, anon, authenticated;

create function public.push_claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  out jsonb := public.push_claim_alerts_and_emails(p_token); -- uses (and checks) the token
  ids bigint[];
begin
  -- No key to sign with (a request made before task 2.8): finish, with the reason.
  update public.callback_outbox c set sent_at = now(), result = 'Not sent: no agent key on record to sign with'
    from public.action_requests r
   where c.sent_at is null and r.id = c.request_id and r.api_key_id is null;
  select array_agg(id) into ids from (
    select id from public.callback_outbox
     where sent_at is null and attempts < 6 and next_attempt_at <= now()
       and (claimed_at is null or claimed_at < now() - interval '1 minute')
     order by id limit 20 for update skip locked) due;
  if ids is null then return out || jsonb_build_object('callbacks', '[]'::jsonb); end if;
  update public.callback_outbox set claimed_at = now(), attempts = attempts + 1 where id = any (ids);
  return out || jsonb_build_object('callbacks', (
    select coalesce(jsonb_agg(public.callback_signed(c) order by c.id), '[]'::jsonb)
      from public.callback_outbox c where c.id = any (ids)));
end $$;

-- p_results.callback: [{"id", "ok", "status", "error"}]
create function public.push_report(p_token text, p_results jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer := public.push_report_alerts_and_emails(p_token, p_results); -- uses (and checks) the token
  r jsonb;
begin
  if jsonb_typeof(p_results) <> 'object' then return n; end if;
  for r in select * from jsonb_array_elements(coalesce(p_results -> 'callback', '[]')) loop
    update public.callback_outbox
       set http_status = nullif(r ->> 'status', '')::integer,
           sent_at = case when (r ->> 'ok')::boolean or attempts >= 6 then now() end,
           next_attempt_at = case when (r ->> 'ok')::boolean then next_attempt_at else now() + public.callback_backoff(attempts) end,
           result = case when (r ->> 'ok')::boolean then 'Delivered (HTTP ' || coalesce(r ->> 'status', '200') || ')'
                         when attempts >= 6 then left('Gave up after 6 tries: ' || coalesce(r ->> 'error', 'no answer'), 300)
                         else left('Not delivered yet: ' || coalesce(r ->> 'error', 'no answer') || ' (will try again)', 300) end
     where id = (r ->> 'id')::bigint and sent_at is null;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.push_retry_due() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.push_dispatch_tokens where created_at < now() - interval '1 day';
  if exists (select 1 from public.push_outbox
              where sent_at is null and attempts < 5 and coalesce(claimed_at, created_at) < now() - interval '1 minute')
     or exists (select 1 from public.email_outbox
              where sent_at is null and attempts < 5 and coalesce(claimed_at, created_at) < now() - interval '1 minute')
     or exists (select 1 from public.callback_outbox
              where sent_at is null and attempts < 6 and next_attempt_at <= now()
                and (claimed_at is null or claimed_at < now() - interval '1 minute')) then
    perform public.push_kick();
  end if;
end $$;

-- "Who was told" now includes the callback to the agent.
create or replace function public.request_notifications(p_request_id uuid)
returns table (channel text, person text, status text, at timestamptz)
language sql stable security definer set search_path = '' as $$
  select x.channel, x.person, x.status, x.at
  from (
    select 'Phone alert' as channel, p.full_name as person,
           coalesce(o.result, 'Sending…') as status, coalesce(o.sent_at, o.created_at) as at, o.id as ord
      from public.push_outbox o join public.profiles p on p.id = o.user_id where o.request_id = p_request_id
    union all
    select 'Email', p.full_name,
           case when e.result = 'Sent' and e.is_test then 'Sent (test inbox)'
                when e.result = 'Sent' and e.sent_to is not null and e.sent_to <> p.email then 'Sent (demo inbox)'
                else coalesce(e.result, 'Sending…') end,
           coalesce(e.sent_at, e.created_at), e.id
      from public.email_outbox e join public.profiles p on p.id = e.user_id where e.request_id = p_request_id
    union all
    select 'Callback to agent', a.name, coalesce(c.result, 'Sending…'), coalesce(c.sent_at, c.claimed_at, c.created_at), c.id
      from public.callback_outbox c
      join public.action_requests r2 on r2.id = c.request_id
      join public.agents a on a.id = r2.agent_id
     where c.request_id = p_request_id
  ) x
  join public.action_requests r on r.id = p_request_id
  where public.can_see_agent(r.agent_id)
  order by x.at, x.channel, x.ord
$$;

-- ---------------------------------------------------------------------------
-- Agent console (demo): plays the Payment Release Assistant, an agent outside the Control Tower
-- ---------------------------------------------------------------------------
create table public.demo_agent_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.action_requests (id) on delete cascade,
  kind text not null check (kind in ('asked', 'callback')),
  delivery_id bigint unique,      -- a retried callback is recorded once
  status text not null,
  may_proceed boolean not null,
  reason text,
  at timestamptz not null default now()
);
alter table public.demo_agent_events enable row level security;
create policy "admins see the agent console" on public.demo_agent_events for select to authenticated using (public.has_role('admin'));
grant select on public.demo_agent_events to authenticated;

-- The console's "Ask" button: the agent asks to release a payment, with a callback to our own receiver.
-- A one-off key is made for the request and revoked straight after (the callback is still signed with it).
create function public.demo_agent_ask(p_amount numeric, p_supplier text, p_reason text, p_test boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  site text;
  k text;
  res jsonb;
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can use the agent console' using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter an amount above zero' using errcode = 'check_violation';
  end if;
  if nullif(trim(p_supplier), '') is null then
    raise exception 'Enter a supplier' using errcode = 'check_violation';
  end if;
  select * into a from public.agents where name = 'Payment Release Assistant';
  if not found or a.status <> 'live' then
    raise exception 'The demo agent (Payment Release Assistant) is not live. Load the demo data first.' using errcode = 'check_violation';
  end if;
  select site_url into site from public.push_config;
  if site is null then
    raise exception 'The site address is not set yet, so the agent cannot be called back. Run Database migrations.' using errcode = 'check_violation';
  end if;

  k := public.create_agent_api_key(a.id);
  res := public.api_request_action(k, jsonb_build_object(
    'idempotency_key', 'console-' || gen_random_uuid(),
    'action', 'payment.release',
    'description', 'Release £' || case when p_amount = trunc(p_amount) then to_char(p_amount, 'FM999,999,999,990')
                                       else to_char(p_amount, 'FM999,999,999,990.00') end || ' to supplier ' || trim(p_supplier),
    'reasoning', nullif(trim(p_reason), ''),
    'amount', p_amount, 'currency', 'GBP', 'urgency', 'high', 'target_system', 'SWIFT gateway',
    'callback_url', site || '/api/v1/demo-agent/callback',
    'details', jsonb_build_object('supplier', trim(p_supplier), 'demo_console', true, 'test', p_test)));
  perform public.revoke_api_key(id) from public.agent_api_keys where key_hash = public.secret_hash(k);

  insert into public.demo_agent_events (request_id, kind, status, may_proceed, reason)
  values ((res ->> 'request_id')::uuid, 'asked', res ->> 'status', (res ->> 'may_proceed')::boolean, res ->> 'reason');
  return res;
end $$;

-- Our stand-in for the agent's own server: checks the signature exactly as an agent would, then records what it heard.
create function public.demo_agent_receive(p_body text, p_signature text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  t text := substring(p_signature from 't=(\d+)');
  v1 text := substring(p_signature from 'v1=([0-9a-f]{64})');
  b jsonb;
  r public.action_requests;
  secret text;
begin
  begin
    b := p_body::jsonb;
    select * into r from public.action_requests where id = (b ->> 'request_id')::uuid and details ->> 'demo_console' = 'true';
  exception when others then
    raise exception 'Signature does not match' using errcode = 'invalid_authorization_specification';
  end;
  select key_hash into secret from public.agent_api_keys where id = r.api_key_id;
  if t is null or v1 is null or secret is null or abs(extract(epoch from now()) - t::bigint) > 300
     or encode(extensions.hmac(t || '.' || p_body, secret, 'sha256'), 'hex') <> v1 then
    raise exception 'Signature does not match' using errcode = 'invalid_authorization_specification';
  end if;
  insert into public.demo_agent_events (request_id, kind, delivery_id, status, may_proceed, reason)
  values (r.id, 'callback', (b ->> 'delivery_id')::bigint, b ->> 'status', coalesce((b ->> 'may_proceed')::boolean, false), b ->> 'reason')
  on conflict (delivery_id) do nothing;
  return 'ok';
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on function public.action_requests_key(), public.action_requests_callback(),
  public.callback_backoff(integer), public.callback_signed(public.callback_outbox),
  public.push_claim(text), public.push_report(text, jsonb),
  public.demo_agent_ask(numeric, text, text, boolean), public.demo_agent_receive(text, text)
  from public, anon, authenticated;
grant execute on function public.push_claim(text), public.push_report(text, jsonb), public.demo_agent_receive(text, text) to anon;
grant execute on function public.demo_agent_ask(numeric, text, text, boolean) to authenticated;
