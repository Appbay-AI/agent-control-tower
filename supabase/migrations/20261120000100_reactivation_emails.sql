-- Task 5.3: emails link to the reactivation approval task; a reply email is never a decision (R4.4).
-- When someone asks to switch a suspended agent back on (task 4.6), everyone who may approve it (admins and approvers
-- for its department, never the person who asked) gets an email with a link to the task (/approvals/reactivations/<id>).
-- For a Critical agent, after the first approval the others get a "second approval needed" email. The decision is made
-- only in the app, signed in: the link opens the task, nothing in an email decides, and no email is ever read back.
-- Not sent if the request was decided or withdrawn before the email went out. Same queue and sender as tasks 2.7 / 5.1;
-- on the work-in-progress site they go to Resend's test inbox and share the 20-a-day limit with alert emails.

alter table public.email_outbox add column reactivation_id uuid references public.agent_reactivations (id) on delete cascade;
alter table public.email_outbox drop constraint email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('new', 'escalated', 'second', 'alert', 'reactivation', 'reactivation_second'));
alter table public.email_outbox add constraint email_outbox_reactivation_complete
  check (kind not in ('reactivation', 'reactivation_second') or reactivation_id is not null);
create index email_outbox_reactivation on public.email_outbox (reactivation_id) where reactivation_id is not null;

-- Queues one email per person; skips the asker and anyone who has approved already.
create function public.reactivation_email(p_reactivation uuid, p_kind text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  cfg public.push_config;
  r public.agent_reactivations;
  capped boolean := false;
  n integer;
begin
  select * into cfg from public.push_config;
  if not found then return 0; end if;
  select * into r from public.agent_reactivations where id = p_reactivation;
  if cfg.alert_email_mode = 'test_inbox' then
    capped := (select count(*) from public.email_outbox
                where kind in ('alert', 'reactivation', 'reactivation_second') and created_at >= date_trunc('day', now())
                  and coalesce(result, '') not like 'Not sent: test site%') >= 20;
  end if;
  insert into public.email_outbox (user_id, kind, reactivation_id, agent_id, is_test, sent_at, result)
  select p.id, p_kind, r.id, r.agent_id, cfg.alert_email_mode = 'test_inbox',
         case when capped then now() end,
         case when capped then 'Not sent: test site daily limit for alert emails (20) reached' end
    from public.profiles p
   where p.is_active and p.id <> r.requested_by
     and public.can_approve_reactivation(r.agent_id, p.id)
     and not exists (select 1 from public.agent_reactivation_approvals x where x.reactivation_id = r.id and x.approver_id = p.id);
  get diagnostics n = row_count;
  return n;
end $$;

create function public.agent_reactivations_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'pending' then perform public.reactivation_email(new.id, 'reactivation'); end if;
  return null;
end $$;
create trigger agent_reactivations_email after insert on public.agent_reactivations
  for each row execute function public.agent_reactivations_email();

create function public.agent_reactivation_approvals_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.agent_reactivations;
begin
  select * into r from public.agent_reactivations where id = new.reactivation_id;
  if r.status = 'pending' and (select count(*) from public.agent_reactivation_approvals where reactivation_id = r.id) < r.required_approvals then
    perform public.reactivation_email(r.id, 'reactivation_second');
  end if;
  return null;
end $$;
create trigger agent_reactivation_approvals_email after insert on public.agent_reactivation_approvals
  for each row execute function public.agent_reactivation_approvals_email();

-- The phone alert for a new request (task 4.6) opens the task too, not just the agent.
create function public.push_outbox_reactivation_task() returns trigger
language plpgsql security definer set search_path = '' as $$
declare rid uuid;
begin
  if new.kind = 'reactivation' and new.title like 'Switch back on? · %' and new.url like '/agents/%' then
    select id into rid from public.agent_reactivations
     where agent_id = nullif(substr(new.url, 9), '')::uuid and status = 'pending' order by requested_at desc limit 1;
    if rid is not null then new.url := '/approvals/reactivations/' || rid; end if;
  end if;
  return new;
end $$;
create trigger push_outbox_reactivation_task before insert on public.push_outbox
  for each row execute function public.push_outbox_reactivation_task();

-- What the email needs, as it stands when it is sent.
create function public.reactivation_email_payload(p_reactivation uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'reason', r.reason, 'asked_by', ab.full_name, 'asked_at', r.requested_at, 'required', r.required_approvals,
    'approved_by', coalesce((select jsonb_agg(p.full_name order by x.approved_at) from public.agent_reactivation_approvals x
                               join public.profiles p on p.id = x.approver_id where x.reactivation_id = r.id), '[]'),
    'agent', jsonb_build_object('id', a.id, 'code', a.agent_code, 'name', a.name, 'risk_tier', a.risk_tier, 'department', d.name),
    'suspension', (select jsonb_build_object('reason', s.reason, 'at', coalesce(s.suspended_at, s.requested_at))
                     from public.agent_suspensions s where s.id = r.suspension_id),
    'incidents', coalesce((select jsonb_agg(jsonb_build_object('code', i.incident_code, 'status', i.status, 'title', i.title) order by i.opened_at)
                             from public.incidents i where i.agent_id = a.id and i.status in ('open', 'contained')), '[]'))
  from public.agent_reactivations r
  join public.agents a on a.id = r.agent_id
  left join public.departments d on d.id = a.department_id
  left join public.profiles ab on ab.id = r.requested_by
  where r.id = p_reactivation
$$;

-- The sender's claim (tasks 2.7 and 5.1), now with reactivation emails.
create or replace function public.push_claim_alerts_and_emails(p_token text) returns jsonb
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

  -- Emails (task 2.7; alert emails, task 5.1; reactivation emails, task 5.3).
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
  update public.email_outbox e set sent_at = now(), result = 'Not sent: already ' || r.status
    from public.agent_reactivations r
   where e.sent_at is null and r.id = e.reactivation_id and r.status <> 'pending';
  update public.email_outbox e set sent_at = now(), result = 'Not sent: approved already'
   where e.sent_at is null and e.reactivation_id is not null
     and exists (select 1 from public.agent_reactivation_approvals x where x.reactivation_id = e.reactivation_id and x.approver_id = e.user_id);
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
      select coalesce(jsonb_agg(case
        when e.kind = 'alert' then jsonb_build_object(
          'id', e.id, 'kind', e.kind, 'test', e.is_test, 'to_name', p.full_name, 'to_email', p.email, 'alert', e.details)
        when e.kind in ('reactivation', 'reactivation_second') then jsonb_build_object(
          'id', e.id, 'kind', e.kind, 'test', e.is_test, 'to_name', p.full_name, 'to_email', p.email,
          'reactivation', public.reactivation_email_payload(e.reactivation_id))
        else jsonb_build_object(
          'id', e.id, 'kind', e.kind, 'test', e.is_test,
          'to_name', p.full_name, 'to_email', p.email,
          'request', jsonb_build_object(
            'id', r.id, 'code', r.request_code, 'agent', a.name, 'headline', public.request_alert_body(r),
            'reasoning', r.reasoning, 'hold_reason', r.hold_reason, 'amount', r.amount, 'currency', r.currency,
            'urgency', r.urgency, 'requested_at', r.requested_at,
            'escalated_by', eb.full_name, 'escalation_reason', r.escalation_reason)) end order by e.id), '[]'::jsonb)
      from public.email_outbox e
      join public.profiles p on p.id = e.user_id
      left join public.action_requests r on r.id = e.request_id
      left join public.agents a on a.id = r.agent_id
      left join public.profiles eb on eb.id = r.escalated_by
      where e.id = any (eids)));
end $$;

-- "Who was told" on the task page: each email and phone alert about this request, its person and what happened.
create function public.reactivation_notifications(p_reactivation uuid)
returns table (channel text, person text, status text, at timestamptz)
language sql stable security definer set search_path = '' as $$
  select x.channel, p.full_name, x.status, x.at
  from (
    select case e.kind when 'reactivation_second' then 'Email (second approval)' else 'Email' end channel, e.user_id,
           case when e.result = 'Sent' and e.is_test then 'Sent (test inbox)'
                when e.result = 'Sent' and e.sent_to is not null and e.sent_to <> pr.email then 'Sent (demo inbox)'
                else coalesce(e.result, 'Sending…') end status,
           coalesce(e.sent_at, e.created_at) at, e.id ord
      from public.email_outbox e join public.profiles pr on pr.id = e.user_id where e.reactivation_id = p_reactivation
    union all
    select 'Phone alert', o.user_id, coalesce(o.result, 'Sending…'), coalesce(o.sent_at, o.created_at), o.id
      from public.push_outbox o where o.url = '/approvals/reactivations/' || p_reactivation
  ) x
  join public.profiles p on p.id = x.user_id
  join public.agent_reactivations r on r.id = p_reactivation
  where public.can_see_agent(r.agent_id)
  order by x.at, x.channel, x.ord
$$;

revoke execute on function public.reactivation_email(uuid, text), public.agent_reactivations_email(),
  public.agent_reactivation_approvals_email(), public.push_outbox_reactivation_task(), public.reactivation_email_payload(uuid)
  from public, anon, authenticated;
revoke execute on function public.reactivation_notifications(uuid) from public, anon;
grant execute on function public.reactivation_notifications(uuid) to authenticated;
