-- Phase 2, task 2.6: phone alerts (Web Push). When an agent action starts waiting for a person, or is escalated to
-- someone, that person's phones and browsers get an alert, even when the app is closed.
--
-- How it fits together (all on free tiers, no new service):
--   1. A person turns alerts on in the app; the browser gives us a push subscription (endpoint + keys), stored here.
--   2. A trigger on action_requests puts one alert per person in push_outbox.
--   3. A trigger on push_outbox asks our own site to send them: pg_net posts a one-time token to
--      <site>/api/v1/push/dispatch after the transaction commits (https://supabase.com/docs/guides/database/extensions/pg_net).
--   4. That Cloudflare function trades the token for the waiting alerts and the signing key (push_claim), encrypts each
--      alert for each device (RFC 8291) and sends it to the browser's push service (Google, Apple or Mozilla), then
--      reports back (push_report). Devices the push service says are gone are removed.
--   5. A pg_cron job retries anything not sent within a minute.
-- The signing key pair (VAPID, RFC 8292) is made by the Database migrations workflow (scripts/push-setup.mjs) and lives
-- only in push_config, which nobody can read directly. No secret is shared with Cloudflare or GitHub.

-- ---------------------------------------------------------------------------
-- Extensions (Supabase provides both; plain Postgres in tests does not, so they are optional here)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.push_config (
  id boolean primary key default true check (id),
  site_url text check (site_url ~ '^https://[^/]+$'),
  vapid_public_key text,          -- base64url, 65-byte uncompressed P-256 point
  vapid_private_jwk jsonb,        -- the private key, as a JWK; only push_claim returns it
  vapid_subject text,             -- contact for push services (RFC 8292): https: or mailto:
  updated_at timestamptz not null default now()
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 2048),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  device text check (length(device) <= 200),
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  last_error text
);
create index on public.push_subscriptions (user_id);

create table public.push_outbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('action_request', 'test')),
  request_id uuid references public.action_requests (id) on delete cascade,
  title text not null,
  body text not null,
  url text not null check (url ~ '^/'),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  attempts integer not null default 0,
  sent_at timestamptz,               -- finished: delivered, or nothing more to try
  devices_reached integer,
  result text
);
create index push_outbox_due on public.push_outbox (id) where sent_at is null;

create table public.push_dispatch_tokens (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  reported_at timestamptz
);

-- Nobody reads these directly. People see their own devices; everything else goes through the functions below.
alter table public.push_config enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_outbox enable row level security;
alter table public.push_dispatch_tokens enable row level security;
create policy "own devices" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
grant select (id, user_id, device, created_at, last_sent_at, last_error) on public.push_subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- Who is alerted about a waiting request: the same people who may decide it (see can_decide_request).
-- The assigned approver, or, when nobody is assigned, every approver for the agent's department.
-- Never the agent's owners or creator; only active people with the Approver role.
-- ---------------------------------------------------------------------------
create function public.request_deciders(r public.action_requests) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select p.id
  from public.profiles p
  join public.agents a on a.id = r.agent_id
  where r.status = 'pending'
    and p.is_active
    and exists (select 1 from public.user_roles ur where ur.user_id = p.id and ur.role = 'approver')
    and p.id is distinct from a.business_owner_id
    and p.id is distinct from a.technical_owner_id
    and p.id is distinct from a.created_by
    and case when r.assigned_to is not null then p.id = r.assigned_to
             else exists (select 1 from public.approver_scopes s where s.user_id = p.id and s.department_id = a.department_id) end
$$;

-- The alert text, e.g. "Payment Release Assistant wants to release £2,000,000 to supplier Hartwell Steel Ltd".
-- Same wording as the app's headline(): the first letter of the description is lower-cased unless it is an acronym.
create function public.request_alert_body(r public.action_requests) returns text
language sql stable security definer set search_path = '' as $$
  select left(case
    when nullif(trim(r.description), '') is null then a.name || ' asks for: ' || replace(replace(r.action, '.', ' '), '_', ' ')
      || coalesce(' (' || r.currency || ' ' || to_char(r.amount, 'FM999,999,999,999,990.##') || ')', '')
    when trim(r.description) ~ '^[A-Z][a-z]' then a.name || ' wants to ' || lower(left(trim(r.description), 1)) || substr(trim(r.description), 2)
    else a.name || ' wants to ' || trim(r.description)
  end, 300)
  from public.agents a where a.id = r.agent_id
$$;

create function public.action_requests_alert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'pending' then return null; end if;
  if tg_op = 'UPDATE' and new.assigned_to is not distinct from old.assigned_to then return null; end if;
  insert into public.push_outbox (user_id, kind, request_id, title, body, url)
  select d, 'action_request', new.id,
         case when new.escalated_at is not null and tg_op = 'UPDATE' then 'Escalated to you · ' else 'Approval needed · ' end
           || new.request_code,
         public.request_alert_body(new),
         '/approvals/requests/' || new.id
  from public.request_deciders(new) d;
  return null;
end $$;

create trigger action_requests_alert after insert or update of assigned_to on public.action_requests
  for each row execute function public.action_requests_alert();

-- ---------------------------------------------------------------------------
-- Asking our site to send: a one-time token, posted by pg_net after commit.
-- ---------------------------------------------------------------------------
create function public.push_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare
  url text;
  token text;
begin
  select site_url into url from public.push_config where vapid_public_key is not null;
  if url is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
  token := public.new_secret('pdt_');
  insert into public.push_dispatch_tokens (token_hash) values (public.secret_hash(token));
  execute 'select net.http_post(url := $1, body := $2, timeout_milliseconds := 5000)'
    using url || '/api/v1/push/dispatch', jsonb_build_object('token', token);
end $$;

create function public.push_outbox_kick() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from queued) then perform public.push_kick(); end if;
  return null;
end $$;

-- Once per statement, so a request that alerts five approvers makes one call.
create trigger push_outbox_kick after insert on public.push_outbox
  referencing new table as queued for each statement execute function public.push_outbox_kick();

-- Retry: anything not finished a minute after it was queued (or after its last try) gets another go.
create function public.push_retry_due() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.push_dispatch_tokens where created_at < now() - interval '1 day';
  if exists (select 1 from public.push_outbox
              where sent_at is null and attempts < 5 and coalesce(claimed_at, created_at) < now() - interval '1 minute') then
    perform public.push_kick();
  end if;
end $$;

do $$
begin
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'push-retry') then
      perform cron.unschedule('push-retry');
    end if;
    perform cron.schedule('push-retry', '* * * * *', 'select public.push_retry_due()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The sender's side (called by the Cloudflare function with the public key, so as role anon).
-- Only someone holding a fresh token from push_kick can claim alerts; each token works once.
-- ---------------------------------------------------------------------------
create function public.push_use_token(p_token text, p_step text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.push_dispatch_tokens;
begin
  select * into t from public.push_dispatch_tokens where token_hash = public.secret_hash(coalesce(p_token, '')) for update;
  if not found or t.created_at < now() - interval '10 minutes'
     or (p_step = 'claim' and t.claimed_at is not null)
     or (p_step = 'report' and (t.claimed_at is null or t.reported_at is not null)) then
    raise exception 'Invalid or used dispatch token' using errcode = 'invalid_authorization_specification';
  end if;
  if p_step = 'claim' then
    update public.push_dispatch_tokens set claimed_at = now() where token_hash = t.token_hash;
  else
    update public.push_dispatch_tokens set reported_at = now() where token_hash = t.token_hash;
  end if;
end $$;

create function public.push_claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cfg public.push_config;
  ids bigint[];
begin
  perform public.push_use_token(p_token, 'claim');
  select * into cfg from public.push_config where vapid_public_key is not null;
  if not found then return jsonb_build_object('messages', '[]'::jsonb); end if;

  update public.push_outbox set sent_at = now(), result = 'Not sent after 5 tries'
   where sent_at is null and attempts >= 5;
  -- Alerts for people with no device switched on (or no longer active) are finished at once.
  update public.push_outbox o set sent_at = now(), devices_reached = 0,
         result = 'No device has alerts switched on'
   where o.sent_at is null
     and not exists (select 1 from public.push_subscriptions s join public.profiles p on p.id = s.user_id
                      where s.user_id = o.user_id and p.is_active);

  select array_agg(id) into ids from (
    select id from public.push_outbox
     where sent_at is null and attempts < 5 and (claimed_at is null or claimed_at < now() - interval '1 minute')
     order by id limit 50 for update skip locked) due;
  if ids is null then return jsonb_build_object('messages', '[]'::jsonb); end if;
  update public.push_outbox set claimed_at = now(), attempts = attempts + 1 where id = any (ids);

  return jsonb_build_object(
    'vapid', jsonb_build_object('public_key', cfg.vapid_public_key, 'private_jwk', cfg.vapid_private_jwk,
                                'subject', coalesce(cfg.vapid_subject, cfg.site_url)),
    'messages', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'title', o.title, 'body', o.body, 'url', o.url,
        'tag', coalesce(o.request_id::text, 'test-' || o.id),
        'subscriptions', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
                            from public.push_subscriptions s where s.user_id = o.user_id)) order by o.id), '[]'::jsonb)
      from public.push_outbox o where o.id = any (ids)));
end $$;

-- p_results: [{"id": <outbox id>, "delivered": [subscription ids], "gone": [subscription ids],
--              "failed": [{"id": <subscription id>, "error": "..."}]}]
create function public.push_report(p_token text, p_results jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb;
  n integer := 0;
  reached integer;
  failed integer;
begin
  perform public.push_use_token(p_token, 'report');
  for r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    reached := jsonb_array_length(coalesce(r -> 'delivered', '[]'));
    failed := jsonb_array_length(coalesce(r -> 'failed', '[]'));
    delete from public.push_subscriptions
     where id in (select (jsonb_array_elements_text(coalesce(r -> 'gone', '[]')))::uuid);
    update public.push_subscriptions set last_sent_at = now(), last_error = null
     where id in (select (jsonb_array_elements_text(coalesce(r -> 'delivered', '[]')))::uuid);
    update public.push_subscriptions s set last_error = left(f ->> 'error', 300)
      from jsonb_array_elements(coalesce(r -> 'failed', '[]')) f
     where s.id = (f ->> 'id')::uuid;
    -- Finished when at least one device got it, or when nothing is left worth retrying.
    update public.push_outbox
       set devices_reached = reached,
           sent_at = case when reached > 0 or failed = 0 or attempts >= 5 then now() end,
           result = case when reached > 0 then 'Sent to ' || reached || ' device(s)'
                         when failed = 0 then 'No device left to send to'
                         else left('Not sent: ' || coalesce(r -> 'failed' -> 0 ->> 'error', 'push service error'), 300) end
     where id = (r ->> 'id')::bigint and sent_at is null;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- The person's side (signed in)
-- ---------------------------------------------------------------------------
create function public.push_public_key() returns text
language sql stable security definer set search_path = '' as $$
  select vapid_public_key from public.push_config
$$;

-- Saves this device for the signed-in person. A device that belonged to someone else (a shared phone) moves to them.
create function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_device text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if not public.is_active_user() then
    raise exception 'Sign in first' using errcode = 'insufficient_privilege';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, device)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_device, 200))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device,
        created_at = now(), last_error = null
  returning id into v;
  return v;
end $$;

create function public.push_unsubscribe(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

-- "Send a test alert" on the Approvals screen.
create function public.push_send_test() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_active_user() then
    raise exception 'Sign in first' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.push_subscriptions where user_id = auth.uid()) then
    raise exception 'Turn alerts on for this device first' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.push_outbox where user_id = auth.uid() and kind = 'test' and created_at > now() - interval '10 seconds') then
    raise exception 'A test alert is already on its way' using errcode = 'check_violation';
  end if;
  insert into public.push_outbox (user_id, kind, title, body, url)
  values (auth.uid(), 'test', 'Test alert', 'Alerts work on this device. Tap to open your approvals.', '/approvals');
end $$;

-- Set by the Database migrations workflow (scripts/push-setup.mjs). New keys make old subscriptions useless, so
-- they are removed and people turn alerts on again.
create function public.push_configure(p_site_url text, p_public_key text default null, p_private_jwk jsonb default null,
                                      p_subject text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  old_key text;
begin
  select vapid_public_key into old_key from public.push_config;
  insert into public.push_config (site_url) values (p_site_url)
  on conflict (id) do update set site_url = excluded.site_url, updated_at = now();
  if p_public_key is not null then
    update public.push_config
       set vapid_public_key = p_public_key, vapid_private_jwk = p_private_jwk,
           vapid_subject = coalesce(p_subject, p_site_url), updated_at = now();
    if old_key is distinct from p_public_key then
      delete from public.push_subscriptions;
    end if;
    return 'keys set';
  end if;
  return 'site url set';
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on function
  public.request_deciders(public.action_requests), public.request_alert_body(public.action_requests),
  public.action_requests_alert(), public.push_kick(), public.push_outbox_kick(), public.push_retry_due(),
  public.push_use_token(text, text), public.push_claim(text), public.push_report(text, jsonb),
  public.push_public_key(), public.push_subscribe(text, text, text, text), public.push_unsubscribe(text),
  public.push_send_test(), public.push_configure(text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.push_claim(text), public.push_report(text, jsonb) to anon;
grant execute on function public.push_public_key(), public.push_subscribe(text, text, text, text),
  public.push_unsubscribe(text), public.push_send_test() to authenticated;
