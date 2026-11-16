-- Task 5.1: alert emails (R4.1, R4.2). Seven events each send an email:
--   suspended, reactivated (switched back on), re-quarantined (switched on outside Control Tower and blocked again),
--   enforcement pending (a stop or restore step has not worked yet), discovered (found on a platform, not registered),
--   missing at source (no longer listed on its platform), and access without authority (the PII mismatch, task 4.8).
-- Each email carries the agent's owner, everyone who can use it with their role and department, the data it touches,
-- and a red flag when it handles personal data. The facts are a snapshot taken when the event happened.
--
-- Who gets them (until alert routing, task 5.2): every active admin, and the agent's business owner.
-- Same path as approval emails (task 2.7): queued in email_outbox, sent by our site through Resend, retried by pg_cron.
--
-- Resend's free plan allows 100 emails a day. On the work-in-progress site, where every test run triggers these
-- events, alert emails go to Resend's test inbox and stop at 20 a day (alert_email_mode 'test_inbox'); the demo sends
-- them for real (to its redirect inbox).

alter table public.push_config
  add column alert_email_mode text not null default 'send' check (alert_email_mode in ('send', 'test_inbox'));

-- Set by the Database migrations workflow (scripts/push-setup.mjs): dev → test_inbox, demo → send.
create function public.alert_email_mode(p_mode text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  update public.push_config set alert_email_mode = p_mode, updated_at = now() where true;
  return format('alert emails: %s', case p_mode when 'send' then 'sent' else 'to the test inbox, 20 a day at most' end);
end $$;
revoke execute on function public.alert_email_mode(text) from public, anon, authenticated;

alter table public.email_outbox
  add column agent_id uuid references public.agents (id) on delete cascade,
  add column event text check (event in ('suspended', 'reactivated', 're_quarantined', 'enforcement_pending', 'discovered',
                                         'missing_at_source', 'access_without_authority')),
  add column details jsonb,
  add column dedupe_key text;
alter table public.email_outbox drop constraint email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check check (kind in ('new', 'escalated', 'second', 'alert'));
alter table public.email_outbox add constraint email_outbox_alert_complete
  check (kind <> 'alert' or (event is not null and details is not null and agent_id is not null));
create unique index email_outbox_alert_once on public.email_outbox (dedupe_key, user_id) where dedupe_key is not null;
create index email_outbox_agent on public.email_outbox (agent_id, created_at desc) where agent_id is not null;

-- ---------------------------------------------------------------------------
-- What every alert email carries (R4.2), as it stands now.
-- ---------------------------------------------------------------------------
create function public.agent_alert_context(p_agent uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'agent', jsonb_build_object('id', a.id, 'code', a.agent_code, 'name', a.name, 'status', a.status, 'risk_tier', a.risk_tier,
                                'department', d.name, 'purpose', nullif(btrim(a.purpose_statement), '')),
    'owner', (select jsonb_build_object('name', p.full_name, 'email', p.email, 'role', p.job_title)
                from public.profiles p where p.id = a.business_owner_id),
    'technical_owner', (select jsonb_build_object('name', p.full_name, 'email', p.email, 'role', p.job_title)
                          from public.profiles p where p.id = a.technical_owner_id),
    'data', to_jsonb(a.data_classifications),
    'systems', to_jsonb(a.systems_accessed),
    'pii', 'personal' = any (a.data_classifications),
    'platform', (select jsonb_build_object('name', c.name, 'external_id', pa.external_id, 'status', pa.status,
                                           'missing_since', pa.missing_since)
                   from public.platform_agents pa join public.platform_connections c on c.id = pa.connection_id
                  where pa.agent_id = a.id order by pa.missing_since nulls first, pa.last_seen_at desc nulls last limit 1),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', coalesce(x.name, x.email), 'email', x.email, 'role', x.job_title,
               'department', coalesce(pd.name, (
                 select nullif(s ->> 'department', '')
                   from public.platform_agents pa2
                  cross join lateral jsonb_array_elements(case when jsonb_typeof(pa2.details -> 'sharedWith') = 'array'
                                                               then pa2.details -> 'sharedWith' else '[]' end) s
                  where pa2.agent_id = a.id and lower(s ->> 'email') = x.email limit 1)),
               'how', to_jsonb(x.how), 'missing', to_jsonb(x.missing)) order by x.how[1], x.name)
        from public.agent_access_compute(a.id) x
        left join public.profiles pp on lower(pp.email) = x.email
        left join public.departments pd on pd.id = pp.department_id), '[]'))
  from public.agents a left join public.departments d on d.id = a.department_id
  where a.id = p_agent
$$;

-- Queues one alert email per person: every active admin and the agent's business owner. p_key makes it once only
-- (a retried trigger or a repeated event never sends twice). Returns how many were queued.
create function public.alert_email(p_agent uuid, p_event text, p_headline text, p_facts jsonb, p_key text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  cfg public.push_config;
  ctx jsonb;
  capped boolean := false;
  n integer;
begin
  select * into cfg from public.push_config;
  if not found then return 0; end if; -- this database sends no alerts at all (not set up)
  ctx := public.agent_alert_context(p_agent);
  if ctx is null then return 0; end if;
  if cfg.alert_email_mode = 'test_inbox' then
    capped := (select count(*) from public.email_outbox
                where kind = 'alert' and created_at >= date_trunc('day', now()) and coalesce(result, '') not like 'Not sent: test site%') >= 20;
  end if;

  insert into public.email_outbox (user_id, kind, agent_id, event, details, dedupe_key, is_test, sent_at, result)
  select r.id, 'alert', p_agent, p_event,
         ctx || jsonb_build_object('event', p_event, 'headline', left(p_headline, 300), 'facts', coalesce(p_facts, '[]'),
                                   'at', now(), 'because', r.because),
         p_key, cfg.alert_email_mode = 'test_inbox',
         case when capped then now() end,
         case when capped then 'Not sent: test site daily limit for alert emails (20) reached' end
    from (select p.id, case when bool_or(x.admin) then 'admin' else 'owner' end because
            from (select u.user_id id, true admin from public.user_roles u where u.role = 'admin'
                  union all
                  select a.business_owner_id, false from public.agents a where a.id = p_agent and a.business_owner_id is not null) x
            join public.profiles p on p.id = x.id
           where p.is_active
           group by p.id) r
  on conflict (dedupe_key, user_id) where dedupe_key is not null do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Facts are [label, value] pairs, in order; blank values are left out.
create function public.alert_facts(variadic p text[]) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_array(p[i], p[i + 1]) order by i), '[]')
    from generate_subscripts(p, 1) i
   where i % 2 = 1 and coalesce(btrim(p[i + 1]), '') <> ''
$$;

-- ---------------------------------------------------------------------------
-- The events
-- ---------------------------------------------------------------------------

-- Suspended (live → suspended) and switched back on (suspended → live).
create function public.agents_alert_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  s record;
  r record;
begin
  if old.status = 'live' and new.status = 'suspended' then
    select x.id, x.reason, x.suspended_at, x.incident_id, rb.full_name requested_by, cb.full_name confirmed_by, i.incident_code
      into s
      from public.agent_suspensions x
      left join public.profiles rb on rb.id = x.requested_by
      left join public.profiles cb on cb.id = x.confirmed_by
      left join public.incidents i on i.id = x.incident_id
     where x.agent_id = new.id and x.status = 'done'
     order by x.suspended_at desc nulls last, x.requested_at desc limit 1;
    perform public.alert_email(new.id, 'suspended', format('%s %s was suspended', new.agent_code, new.name),
      public.alert_facts(
        'Why', coalesce(s.reason, nullif(current_setting('act.reason', true), '')),
        'Suspended by', case when s.id is null then 'Control Tower'
                             when s.requested_by is null then format('Control Tower, automatically (Critical incident %s)', s.incident_code)
                             else s.requested_by end,
        'Confirmed by', s.confirmed_by,
        'What happens now', 'Every check it makes with the Control Tower is refused, and it is being stopped everywhere the Control Tower can reach (see its page for each step). An incident is opened.'),
      format('suspended:%s:%s', new.id, coalesce(s.id::text, txid_current()::text)));
  elsif old.status = 'suspended' and new.status = 'live' then
    select x.id, x.reason, rb.full_name requested_by,
           (select string_agg(p.full_name, ', ' order by ap.approved_at) from public.agent_reactivation_approvals ap
              join public.profiles p on p.id = ap.approver_id where ap.reactivation_id = x.id) approved_by
      into r
      from public.agent_reactivations x left join public.profiles rb on rb.id = x.requested_by
     where x.agent_id = new.id and x.status in ('approved', 'pending')
     order by x.requested_at desc limit 1;
    perform public.alert_email(new.id, 'reactivated', format('%s %s was switched back on', new.agent_code, new.name),
      public.alert_facts(
        'Why it is safe', coalesce(r.reason, nullif(current_setting('act.reason', true), '')),
        'Asked by', r.requested_by,
        'Approved by', r.approved_by,
        'What happens now', 'It is being switched back on where it was stopped, and its checks with the Control Tower are answered again.'),
      format('reactivated:%s:%s', new.id, coalesce(r.id::text, txid_current()::text)));
  end if;
  return null;
end $$;
create trigger agents_alert_email after update of status on public.agents
  for each row execute function public.agents_alert_email();

-- Re-quarantined: switched back on outside Control Tower and blocked again (task 4.7; the drift record of task 4.9).
create function public.drift_alert_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare a public.agents;
begin
  if new.kind <> 'switched_on_outside' then return null; end if;
  select * into a from public.agents where id = new.agent_id;
  perform public.alert_email(new.agent_id, 're_quarantined',
    format('%s %s was switched back on outside Control Tower and is being blocked again', a.agent_code, a.name),
    public.alert_facts('Expected', new.expected, 'Seen', new.observed, 'Who', new.actor, 'Done', new.action,
                       'Incident', (select incident_code from public.incidents where id = new.incident_id)),
    'requarantine:' || new.id);
  return null;
end $$;
create trigger drift_alert_email after insert on public.drift_events
  for each row execute function public.drift_alert_email();

-- Enforcement pending (task 4.3) and discovered (task 3.5): when their alert is raised.
create function public.alerts_alert_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  pa record;
begin
  if new.kind not in ('enforcement_pending', 'agent_discovered') or new.agent_id is null then return null; end if;
  select * into a from public.agents where id = new.agent_id;
  if new.kind = 'enforcement_pending' then
    perform public.alert_email(a.id, 'enforcement_pending',
      case when a.status = 'suspended' then format('%s %s is suspended but not stopped everywhere yet', a.agent_code, a.name)
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
create trigger alerts_alert_email after insert on public.alerts
  for each row execute function public.alerts_alert_email();

-- Missing at source: a sync no longer finds it on its platform (task 3.3).
create function public.platform_agents_missing_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  conn text;
begin
  if new.agent_id is null or new.missing_since is null or old.missing_since is not null then return null; end if;
  select * into a from public.agents where id = new.agent_id;
  if a.status = 'retired' then return null; end if;
  select name into conn from public.platform_connections where id = new.connection_id;
  perform public.alert_email(a.id, 'missing_at_source', format('%s %s is no longer listed on %s', a.agent_code, a.name, conn),
    public.alert_facts('Was', format('%s on %s', new.external_id, conn),
                       'Last seen', to_char(coalesce(old.last_seen_at, new.missing_since) at time zone 'UTC', 'DD Mon YYYY HH24:MI "UTC"'),
                       'In Control Tower', initcap(a.status::text),
                       'What to do', 'If it was deleted on purpose, retire it in Control Tower. If not, check the platform: someone may have deleted or moved it outside Control Tower.'),
    format('missing:%s:%s', new.id, new.missing_since));
  return null;
end $$;
create trigger platform_agents_missing_email after update of missing_since on public.platform_agents
  for each row execute function public.platform_agents_missing_email();

-- Access without authority (task 4.8): a new person who can use the agent but whose role may not see its data.
create function public.authority_finding_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare a public.agents;
begin
  select * into a from public.agents where id = new.agent_id;
  perform public.alert_email(a.id, 'access_without_authority',
    format('%s can use %s %s without authority for %s data', coalesce(new.name, new.email), a.agent_code, a.name,
           public.authority_label(new.missing)),
    public.alert_facts('Person', format('%s (%s)', coalesce(new.name, new.email), new.email),
                       'Role', coalesce(new.job_title, 'Not known'),
                       'Access through', array_to_string(new.how, ', '),
                       'Not authorised for', public.authority_label(new.missing),
                       'What to do', 'Remove their access to the agent, or, if their role should see this data, tick it in the Data authority matrix (Users page).'),
    format('authority:%s:%s:%s', new.agent_id, new.email, new.first_seen_at));
  return null;
end $$;
create trigger authority_finding_email after insert on public.agent_authority_findings
  for each row execute function public.authority_finding_email();

-- ---------------------------------------------------------------------------
-- The sender's claim (task 2.7's, which the 2.8 claim wraps): approval emails as before, plus alert emails.
-- ---------------------------------------------------------------------------
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

  -- Emails (task 2.7; alert emails, task 5.1).
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
      select coalesce(jsonb_agg(case when e.kind = 'alert' then jsonb_build_object(
          'id', e.id, 'kind', e.kind, 'test', e.is_test, 'to_name', p.full_name, 'to_email', p.email, 'alert', e.details)
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

-- "Who was told" on the agent's page: each alert email, its person, the event and what happened (no addresses).
create function public.agent_alert_emails(p_agent uuid)
returns table (event text, headline text, person text, status text, at timestamptz)
language sql stable security definer set search_path = '' as $$
  select e.event, e.details ->> 'headline', p.full_name,
         case when e.result = 'Sent' and e.is_test then 'Sent (test inbox)'
              when e.result = 'Sent' and e.sent_to is not null and e.sent_to <> p.email then 'Sent (demo inbox)'
              else coalesce(e.result, 'Sending…') end,
         coalesce(e.sent_at, e.created_at)
    from public.email_outbox e join public.profiles p on p.id = e.user_id
   where e.agent_id = p_agent and e.kind = 'alert' and public.can_see_agent(p_agent)
   order by e.created_at desc, e.id desc
   limit 100
$$;

revoke execute on function public.agent_alert_context(uuid), public.alert_email(uuid, text, text, jsonb, text),
  public.agents_alert_email(), public.drift_alert_email(), public.alerts_alert_email(), public.platform_agents_missing_email(),
  public.authority_finding_email() from public, anon, authenticated;
revoke execute on function public.agent_alert_emails(uuid) from public, anon;
grant execute on function public.agent_alert_emails(uuid) to authenticated;
