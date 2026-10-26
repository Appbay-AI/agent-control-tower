-- Phase 2, task 2.7: approval emails. The people alerted on their phones (task 2.6) also get an email: what the agent
-- wants, why, why it needs a person, and a link to the task. Same queue-and-dispatch path as phone alerts:
-- a trigger queues one email per person, pg_net asks our site to send, the Cloudflare function sends through Resend
-- (https://resend.com) and reports back. pg_cron retries.
--
-- Temporary mode (until notify.appbaytech.com is verified in Resend): emails come from Resend's test sender, which can
-- only deliver to the Resend account's own address. A "redirect inbox" is then set, and every email goes there,
-- marked with who it was for. The demo people's addresses (…@northbridge.demo) are not real mailboxes, so the demo
-- keeps a redirect inbox even after the domain is verified. Requests an agent marks as tests (details.test = true,
-- used by the automated tests) go to Resend's test inbox (delivered@resend.dev), never to a person.
--
-- Settings live in push_config (readable by no one): the Resend API key comes from the RESEND_API_KEY GitHub secret
-- through the Database migrations workflow (scripts/push-setup.mjs), like the alert keys.

alter table public.push_config
  add column email_api_key text,
  add column email_from text,
  add column email_redirect_to text check (email_redirect_to ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

create table public.email_outbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  request_id uuid references public.action_requests (id) on delete cascade,
  kind text not null check (kind in ('new', 'escalated')),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  attempts integer not null default 0,
  sent_at timestamptz,          -- finished: sent, or nothing more to try
  sent_to text,                 -- the address actually used (redirect inbox, test inbox or the person's own)
  provider_id text,             -- Resend's id for the email
  result text
);
create index email_outbox_due on public.email_outbox (id) where sent_at is null;
alter table public.email_outbox enable row level security; -- no policies, no grants: functions only

-- The request trigger from task 2.6, now also queueing emails.
create or replace function public.action_requests_alert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  escalated boolean := new.escalated_at is not null and tg_op = 'UPDATE';
begin
  if new.status <> 'pending' then return null; end if;
  if tg_op = 'UPDATE' and new.assigned_to is not distinct from old.assigned_to then return null; end if;
  insert into public.push_outbox (user_id, kind, request_id, title, body, url)
  select d, 'action_request', new.id,
         case when escalated then 'Escalated to you · ' else 'Approval needed · ' end || new.request_code,
         public.request_alert_body(new),
         '/approvals/requests/' || new.id
  from public.request_deciders(new) d;
  insert into public.email_outbox (user_id, request_id, kind, is_test)
  select d, new.id, case when escalated then 'escalated' else 'new' end, coalesce(new.details ->> 'test', '') = 'true'
  from public.request_deciders(new) d;
  return null;
end $$;

-- Emails queued → ask the site to send (one call per statement, as for alerts).
create trigger email_outbox_kick after insert on public.email_outbox
  referencing new table as queued for each statement execute function public.push_outbox_kick();

-- Kick whenever the site is known (alerts or email may be set up on their own).
create or replace function public.push_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare
  url text;
  token text;
begin
  select site_url into url from public.push_config;
  if url is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
  -- One call per transaction is enough: the sender claims everything queued by then (pg_net sends after commit).
  if current_setting('act.push_kicked', true) = txid_current()::text then return; end if;
  perform set_config('act.push_kicked', txid_current()::text, true);
  token := public.new_secret('pdt_');
  insert into public.push_dispatch_tokens (token_hash) values (public.secret_hash(token));
  execute 'select net.http_post(url := $1, body := $2, timeout_milliseconds := 5000)'
    using url || '/api/v1/push/dispatch', jsonb_build_object('token', token);
end $$;

create or replace function public.push_retry_due() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.push_dispatch_tokens where created_at < now() - interval '1 day';
  if exists (select 1 from public.push_outbox
              where sent_at is null and attempts < 5 and coalesce(claimed_at, created_at) < now() - interval '1 minute')
     or exists (select 1 from public.email_outbox
              where sent_at is null and attempts < 5 and coalesce(claimed_at, created_at) < now() - interval '1 minute') then
    perform public.push_kick();
  end if;
end $$;

-- The sender's claim: phone alerts as before, plus emails with everything needed to write them.
create or replace function public.push_claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cfg public.push_config;
  ids bigint[];
  eids bigint[];
  out jsonb := jsonb_build_object('messages', '[]'::jsonb, 'emails', '[]'::jsonb);
begin
  perform public.push_use_token(p_token, 'claim');
  select * into cfg from public.push_config;
  if not found then return out; end if;

  -- Phone alerts (task 2.6, unchanged).
  if cfg.vapid_public_key is not null then
    update public.push_outbox set sent_at = now(), result = 'Not sent after 5 tries'
     where sent_at is null and attempts >= 5;
    update public.push_outbox o set sent_at = now(), devices_reached = 0, result = 'No device has alerts switched on'
     where o.sent_at is null
       and not exists (select 1 from public.push_subscriptions s join public.profiles p on p.id = s.user_id
                        where s.user_id = o.user_id and p.is_active);
    select array_agg(id) into ids from (
      select id from public.push_outbox
       where sent_at is null and attempts < 5 and (claimed_at is null or claimed_at < now() - interval '1 minute')
       order by id limit 50 for update skip locked) due;
    if ids is not null then
      update public.push_outbox set claimed_at = now(), attempts = attempts + 1 where id = any (ids);
      out := out || jsonb_build_object(
        'vapid', jsonb_build_object('public_key', cfg.vapid_public_key, 'private_jwk', cfg.vapid_private_jwk,
                                    'subject', coalesce(cfg.vapid_subject, cfg.site_url)),
        'messages', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', o.id, 'title', o.title, 'body', o.body, 'url', o.url,
            'tag', coalesce(o.request_id::text, 'test-' || o.id),
            'subscriptions', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
                                from public.push_subscriptions s where s.user_id = o.user_id)) order by o.id), '[]'::jsonb)
          from public.push_outbox o where o.id = any (ids)));
    end if;
  end if;

  -- Emails (task 2.7).
  update public.email_outbox set sent_at = now(), result = 'Not sent after 5 tries'
   where sent_at is null and attempts >= 5;
  if cfg.email_api_key is null then
    update public.email_outbox set sent_at = now(), result = 'Not sent: email is not set up yet' where sent_at is null;
    return out;
  end if;
  -- Decided (or cancelled) before the email went out: nothing to ask any more.
  update public.email_outbox e set sent_at = now(), result = 'Not sent: already ' || r.status
    from public.action_requests r
   where e.sent_at is null and r.id = e.request_id and r.status <> 'pending';
  update public.email_outbox e set sent_at = now(), result = 'Not sent: person no longer active'
    from public.profiles p
   where e.sent_at is null and p.id = e.user_id and not p.is_active;

  select array_agg(id) into eids from (
    select id from public.email_outbox
     where sent_at is null and attempts < 5 and (claimed_at is null or claimed_at < now() - interval '1 minute')
     order by id limit 20 for update skip locked) due;
  if eids is null then return out; end if;
  update public.email_outbox set claimed_at = now(), attempts = attempts + 1 where id = any (eids);

  return out || jsonb_build_object(
    'email', jsonb_build_object('api_key', cfg.email_api_key,
                                'from', coalesce(cfg.email_from, 'Agent Control Tower <onboarding@resend.dev>'),
                                'redirect_to', cfg.email_redirect_to, 'site_url', cfg.site_url),
    'emails', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'kind', e.kind, 'test', e.is_test,
        'to_name', p.full_name, 'to_email', p.email,
        'request', jsonb_build_object(
          'id', r.id, 'code', r.request_code, 'agent', a.name, 'headline', public.request_alert_body(r),
          'reasoning', r.reasoning, 'hold_reason', r.hold_reason, 'amount', r.amount, 'currency', r.currency,
          'urgency', r.urgency, 'requested_at', r.requested_at,
          'escalated_by', eb.full_name, 'escalation_reason', r.escalation_reason)) order by e.id), '[]'::jsonb)
      from public.email_outbox e
      join public.profiles p on p.id = e.user_id
      join public.action_requests r on r.id = e.request_id
      join public.agents a on a.id = r.agent_id
      left join public.profiles eb on eb.id = r.escalated_by
      where e.id = any (eids)));
end $$;

-- The sender's report. p_results is either the task 2.6 list of alert results, or
-- {"push": [...alert results...], "email": [{"id", "sent", "provider_id", "sent_to", "error", "retry"}]}.
create or replace function public.push_report(p_token text, p_results jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb;
  n integer := 0;
  reached integer;
  failed integer;
  pushes jsonb := case when jsonb_typeof(p_results) = 'array' then p_results else coalesce(p_results -> 'push', '[]') end;
  emails jsonb := case when jsonb_typeof(p_results) = 'object' then coalesce(p_results -> 'email', '[]') else '[]' end;
begin
  perform public.push_use_token(p_token, 'report');
  for r in select * from jsonb_array_elements(pushes) loop
    reached := jsonb_array_length(coalesce(r -> 'delivered', '[]'));
    failed := jsonb_array_length(coalesce(r -> 'failed', '[]'));
    delete from public.push_subscriptions
     where id in (select (jsonb_array_elements_text(coalesce(r -> 'gone', '[]')))::uuid);
    update public.push_subscriptions set last_sent_at = now(), last_error = null
     where id in (select (jsonb_array_elements_text(coalesce(r -> 'delivered', '[]')))::uuid);
    update public.push_subscriptions s set last_error = left(f ->> 'error', 300)
      from jsonb_array_elements(coalesce(r -> 'failed', '[]')) f
     where s.id = (f ->> 'id')::uuid;
    update public.push_outbox
       set devices_reached = reached,
           sent_at = case when reached > 0 or failed = 0 or attempts >= 5 then now() end,
           result = case when reached > 0 then 'Sent to ' || reached || ' device(s)'
                         when failed = 0 then 'No device left to send to'
                         else left('Not sent: ' || coalesce(r -> 'failed' -> 0 ->> 'error', 'push service error'), 300) end
     where id = (r ->> 'id')::bigint and sent_at is null;
    n := n + 1;
  end loop;
  for r in select * from jsonb_array_elements(emails) loop
    update public.email_outbox
       set sent_to = left(r ->> 'sent_to', 320),
           provider_id = left(r ->> 'provider_id', 100),
           sent_at = case when (r ->> 'sent')::boolean or not coalesce((r ->> 'retry')::boolean, false) or attempts >= 5 then now() end,
           result = case when (r ->> 'sent')::boolean then 'Sent'
                         else left('Not sent: ' || coalesce(r ->> 'error', 'email service error'), 300) end
     where id = (r ->> 'id')::bigint and sent_at is null;
    n := n + 1;
  end loop;
  return n;
end $$;

-- "Who was told" on the request page: each alert and email, its person and what happened. No addresses or device
-- details; only for people who can see the request.
create function public.request_notifications(p_request_id uuid)
returns table (channel text, person text, status text, at timestamptz)
language sql stable security definer set search_path = '' as $$
  select x.channel, p.full_name, x.status, x.at
  from (
    select 'Phone alert' as channel, o.user_id,
           coalesce(o.result, 'Sending…') as status, coalesce(o.sent_at, o.created_at) as at, o.id as ord
      from public.push_outbox o where o.request_id = p_request_id
    union all
    select 'Email', e.user_id,
           case when e.result = 'Sent' and e.is_test then 'Sent (test inbox)'
                when e.result = 'Sent' and e.sent_to is not null and e.sent_to <> p.email then 'Sent (demo inbox)'
                else coalesce(e.result, 'Sending…') end,
           coalesce(e.sent_at, e.created_at), e.id
      from public.email_outbox e join public.profiles p on p.id = e.user_id where e.request_id = p_request_id
  ) x
  join public.profiles p on p.id = x.user_id
  join public.action_requests r on r.id = p_request_id
  where public.can_see_agent(r.agent_id)
  order by x.at, x.channel, x.ord
$$;

-- Set by the Database migrations workflow. The key is replaced (or removed, when the secret is gone) on every run;
-- the sender and redirect inbox change only when given.
create function public.email_configure(p_api_key text, p_from text default null, p_redirect_to text default null) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.push_config) then
    raise exception 'Set the site first (push_configure)' using errcode = 'check_violation';
  end if;
  update public.push_config
     set email_api_key = nullif(trim(p_api_key), ''),
         email_from = coalesce(nullif(trim(p_from), ''), email_from),
         email_redirect_to = coalesce(nullif(lower(trim(p_redirect_to)), ''), email_redirect_to),
         updated_at = now();
  return case when nullif(trim(p_api_key), '') is null then 'email off (no key)' else 'email on' end;
end $$;

revoke execute on function public.request_notifications(uuid), public.email_configure(text, text, text)
  from public, anon, authenticated;
grant execute on function public.request_notifications(uuid) to authenticated;
-- push_claim / push_report keep their grants (create or replace keeps them).
