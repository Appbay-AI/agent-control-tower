-- Northbridge Bank, part 3 (task 7.1, final demo data): the last twelve weeks, so that the screens built in Phases 4 to 6
-- (the dashboards, the risk view, drift and sync, My work, the audit trail and the evidence pack) tell a story instead of
-- showing zeros. Run after 00_helpers.sql and 02 to 06 in the same psql session. Idempotent.
--
-- The story, week by week:
--   * Agents' requests decided by people every week (payments, refunds, reconciliation breaks, rotas), with the time to
--     decide falling from over three hours to about half an hour as routing settled in; a few turned down with a reason.
--   * Agents refused by policy for trying to act when they may only observe (the breaches on the risk view).
--   * Seven incidents: five closed, one resolved and waiting for Ravi Menon to approve its closure, and ONE OPEN
--     (Affordability Checker, two days old, past its time limit).
--   * One kill switch: a Critical incident on the Payment Release Assistant five weeks ago suspended it at once; the agent
--     was stopped, the incident closed, and two approvers switched it back on.
--   * Five changes made on the agent platform outside Control Tower (the drift report).
--   * Two autonomy changes.
--
-- Everything goes through the real workflow functions, signed in as the right persona, so the records and the audit
-- trail are the ones the app itself would write. Their dates are then moved back (as 02 and 03 do for registrations);
-- the audit entries themselves keep the time the seed ran, because the audit trail can never be changed.
-- Alerts, emails and phone notifications raised while writing this history are removed at the end: they are about the
-- past, and nobody should be emailed about them. Steps that would call out to an agent are marked done. It all runs in
-- one transaction, so none of it is sent before it is tidied.

-- One transaction: nothing raised while writing the history (emails, phone alerts, stop requests to agents) can leave
-- before it is tidied away at the end, because the database hands such work out only after it commits.
begin;

create temp table if not exists hist_marks (push bigint, email bigint, note bigint, callback bigint, alerts uuid[]) on commit preserve rows;
create temp table if not exists hist_requests (id uuid primary key, at timestamptz, minutes int) on commit preserve rows;
create temp table if not exists hist_incidents (id uuid primary key, at timestamptz, contained int, resolved int, closure int, closed int) on commit preserve rows;

do $$ begin
  if exists (select 1 from public.action_requests where idempotency_key like 'hist-%') then
    raise notice 'History already seeded; nothing to do';
    return;
  end if;
  delete from hist_marks; delete from hist_requests; delete from hist_incidents;
  insert into hist_marks values (coalesce((select max(id) from public.push_outbox), 0), coalesce((select max(id) from public.email_outbox), 0),
    coalesce((select max(id) from public.notifications), 0), coalesce((select max(id) from public.callback_outbox), 0),
    coalesce((select array_agg(id) from public.alerts where resolved_at is null), '{}'));
end $$;

-- A time in the past: midnight `days` days ago, plus `hours`.
create or replace function pg_temp.hist_at(p_days int, p_hours numeric) returns timestamptz language sql stable as $$
  select date_trunc('day', now()) - make_interval(days => p_days) + make_interval(secs => p_hours * 3600)
$$;

-- An approver who may decide for the agent's department, other than `p_not`.
create or replace function pg_temp.hist_approver(p_agent uuid, p_not uuid) returns uuid language sql stable as $$
  select coalesce(
    (select s.user_id from public.approver_scopes s join public.profiles p on p.id = s.user_id
      where s.department_id = (select department_id from public.agents where id = p_agent)
        and s.user_id is distinct from p_not and p.email <> 'ravi.menon@northbridge.demo' order by p.email limit 1),
    (select id from public.profiles where email = 'ravi.menon@northbridge.demo' and id is distinct from p_not),
    (select id from public.profiles where email = 'daniel.okafor@northbridge.demo'))
$$;

-- One request from an agent, `p_days` days ago at `p_hour`, decided by people `p_minutes` later
-- (p_decision 'approve' or 'reject'; null when policy decides it at once).
create or replace function pg_temp.hist_request(p_agent text, p_days int, p_hour numeric, p_payload jsonb,
  p_decision text, p_reason text, p_minutes int) returns uuid
language plpgsql as $$
declare
  a uuid := pg_temp.agent(p_agent);
  k text;
  r jsonb;
  req uuid;
  who uuid;
  first uuid;
begin
  perform pg_temp.act_as('admin@northbridge.demo');
  k := public.create_agent_api_key(a);
  perform pg_temp.act_as_system();
  r := public.api_request_action(k, p_payload || jsonb_build_object('idempotency_key', format('hist-%s-%s-%s', p_days, p_hour, md5(p_payload::text))));
  req := (r ->> 'request_id')::uuid;
  perform pg_temp.act_as('admin@northbridge.demo');
  perform public.revoke_api_key(x.id) from public.agent_api_keys x where x.agent_id = a and x.revoked_at is null and x.key_hash = public.secret_hash(k);
  if p_decision is not null then
    -- The person it was routed to, or an approver for the department; a second approver when four-eyes applies.
    loop
      exit when (select status from public.action_requests where action_requests.id = req) <> 'pending';
      who := coalesce((select assigned_to from public.action_requests where action_requests.id = req), pg_temp.hist_approver(a, first));
      if who = first then who := pg_temp.hist_approver(a, first); end if;
      perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
      perform public.decide_action_request(req, p_decision, p_reason);
      first := coalesce(first, who);
    end loop;
  end if;
  perform pg_temp.act_as_system();
  insert into hist_requests values (req, pg_temp.hist_at(p_days, p_hour), coalesce(p_minutes, 0));
  return req;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Twelve weeks of agents' requests.
-- ---------------------------------------------------------------------------
do $$
declare
  w int;          -- weeks ago, 11 (oldest) to 0
  d int;          -- days ago
  base int;       -- typical minutes to decide that week: about 6 hours twelve weeks ago, about 40 minutes now (spread around it)
  f numeric;
  amt numeric;
  supplier text;
  suppliers text[] := array['Hartwell Steel Ltd', 'Calder Logistics', 'Pennine Packaging', 'Brightwater Utilities', 'Oakfield Facilities',
                            'Marlow IT Services', 'Severn Freight', 'Ashby Print Group', 'Kestrel Security', 'Lune Valley Foods', 'Tamar Engineering', 'Wye Office Supplies'];
  branches text[] := array['Leeds', 'Manchester', 'Bristol', 'Glasgow', 'Cardiff', 'Norwich'];
begin
  if exists (select 1 from public.action_requests where idempotency_key like 'hist-%') then return; end if;
  for w in reverse 11..0 loop
    base := 40 + w * 29;
    d := w * 7 + 1;

    -- Payment Release Assistant: supplier payments above its £250,000 limit. Critical, so two people approve.
    amt := 300000 + ((w * 7919) % 1500) * 1000;
    supplier := suppliers[w + 1];
    perform pg_temp.hist_request('Payment Release Assistant', d + 2, 9.5, jsonb_build_object(
      'action', 'payment.release', 'description', format('Release £%s to supplier %s', to_char(amt, 'FM9G999G999'), supplier),
      'reasoning', format('Invoice matches the purchase order and goods receipt; due this week. %s is an approved supplier.', supplier),
      'amount', amt, 'currency', 'GBP', 'urgency', 'normal', 'target_system', 'SWIFT gateway',
      'details', jsonb_build_object('supplier', supplier)),
      case when w = 7 then 'reject' else 'approve' end,
      case when w = 7 then 'The supplier changed its bank details two days before this payment; call them back on the number we hold before paying.' end,
      round(base * 1.3)::int);

    -- Chat Refund Agent: goodwill refunds above its £200 limit, two a week; now and then the refund is not a fee.
    for i in 1..2 loop
      amt := 220 + ((w * 37 + i * 113) % 430);
      perform pg_temp.hist_request('Chat Refund Agent', d + i - 1, 10 + i * 2.25, jsonb_build_object(
        'action', 'refund.fee', 'description', format('Refund £%s of fees to a customer in web chat', amt),
        'reasoning', 'Three overdraft fees in one month after a salary paid late by the employer; meets the published goodwill criteria apart from the amount.',
        'amount', amt, 'currency', 'GBP', 'urgency', 'normal', 'target_system', 'Core banking'),
        case when (w + i) % 5 = 0 then 'reject' else 'approve' end,
        case when (w + i) % 5 = 0 then 'Part of this is interest, not fees; goodwill refunds cover fees only.' end,
        round(base * (0.6 + ((w * 3 + i) % 7) / 10.0))::int);
    end loop;

    -- Reconciliation Exceptions Agent: breaks above its £10,000 limit.
    amt := 12000 + ((w * 4513) % 36) * 1000;
    perform pg_temp.hist_request('Reconciliation Exceptions Agent', d + 3, 14.0, jsonb_build_object(
      'action', 'recon.clear_break', 'description', format('Clear a £%s break on the EUR nostro', to_char(amt, 'FM999G999')),
      'reasoning', 'Matched to a late SWIFT confirmation with the same reference and value date.',
      'amount', amt, 'currency', 'GBP', 'urgency', 'normal', 'target_system', 'SmartStream TLM'),
      'approve', null, round(base * 0.8)::int);

    -- Branch Rota Planner: level 2, so every rota needs a person.
    perform pg_temp.hist_request('Branch Rota Planner', d + 4, 11.0, jsonb_build_object(
      'action', 'rota.publish', 'description', format('Publish the staff rota for the %s branch', branches[(w % 6) + 1]),
      'reasoning', 'All shifts are covered and no one is over 48 hours.', 'urgency', 'normal', 'target_system', 'Workday'),
      'approve', null, round(base * 0.9)::int);

    -- Invoice Matcher: within its limits, so policy lets it act at once (logged for sampling).
    perform pg_temp.hist_request('Invoice Matcher', d + 1, 15.5, jsonb_build_object(
      'action', 'invoice.mark_matched', 'description', format('Mark invoice %s-%s as matched', upper(left(suppliers[w + 1], 2)), 40000 + w * 17),
      'reasoning', 'Three-way match: invoice, purchase order and goods receipt agree.', 'amount', 1200 + w * 310, 'currency', 'GBP'),
      null, null, null);
  end loop;

  -- Refused by policy: observe-only agents that tried to act (each is a breach on the risk view).
  perform pg_temp.hist_request('Sanctions Pre-screener', 64, 9.25, jsonb_build_object('action', 'payment.release',
    'description', 'Release a held payment to Ardent Trading FZE after screening', 'reasoning', 'Screening found no exact match; the payment has been held for four hours.',
    'amount', 86000, 'currency', 'USD', 'target_system', 'SWIFT gateway'), null, null, null);
  perform pg_temp.hist_request('Cash Forecast Agent', 43, 7.5, jsonb_build_object('action', 'funds.move',
    'description', 'Move £5,000,000 from the reserve account to cover tomorrow''s forecast shortfall', 'reasoning', 'Forecast shows an intraday shortfall at 11:00.',
    'amount', 5000000, 'currency', 'GBP', 'target_system', 'Kyriba'), null, null, null);
  perform pg_temp.hist_request('Sanctions Pre-screener', 29, 16.0, jsonb_build_object('action', 'screening.clear_hit',
    'description', 'Clear a possible sanctions match for a beneficiary', 'reasoning', 'Date of birth differs from the listed person.',
    'target_system', 'World-Check'), null, null, null);
  perform pg_temp.hist_request('Cash Forecast Agent', 15, 7.75, jsonb_build_object('action', 'funds.move',
    'description', 'Move £2,500,000 between operating accounts', 'reasoning', 'Balances out of line with the forecast.',
    'amount', 2500000, 'currency', 'GBP', 'target_system', 'Kyriba'), null, null, null);
  perform pg_temp.hist_request('Sanctions Pre-screener', 5, 10.5, jsonb_build_object('action', 'payment.release',
    'description', 'Release a held payment to Baltic Grain Exports after screening', 'reasoning', 'No match found on the current lists.',
    'amount', 41000, 'currency', 'EUR', 'target_system', 'SWIFT gateway'), null, null, null);
end $$;

-- ---------------------------------------------------------------------------
-- 2. Incidents, and the kill switch.
-- ---------------------------------------------------------------------------
-- Report as the owner, fill in the case, contain, resolve, and (when p_closer is given) ask for and approve closure.
create or replace function pg_temp.hist_incident(p_agent text, p_by text, p_days int, p_hour numeric, p_title text, p_severity public.risk_tier,
  p_description text, p_fields jsonb, p_stage text, p_closer text, p_times int[]) returns uuid
language plpgsql as $$
declare i public.incidents;
begin
  perform pg_temp.act_as(p_by);
  i := public.report_incident(pg_temp.agent(p_agent), p_title, p_severity, p_description);
  if p_stage in ('contained', 'resolved', 'closure', 'closed') then
    perform public.incident_save_fields(i.id, jsonb_build_object('containment', p_fields ->> 'containment'));
    perform public.incident_set_status(i.id, 'contained');
  end if;
  if p_stage in ('resolved', 'closure', 'closed') then
    perform public.incident_save_fields(i.id, p_fields - 'containment');
    perform public.incident_set_status(i.id, 'resolved');
  end if;
  if p_stage in ('closure', 'closed') then
    perform public.request_incident_closure(i.id, pg_temp.uid(p_closer), 'Fix confirmed in production.');
  end if;
  if p_stage = 'closed' then
    perform pg_temp.act_as(p_closer);
    perform public.decide_incident_closure(i.id, true, 'Root cause and fix reviewed.');
  end if;
  perform pg_temp.act_as_system();
  insert into hist_incidents values (i.id, pg_temp.hist_at(p_days, p_hour), p_times[1], p_times[2], p_times[3], p_times[4]);
  return i.id;
end $$;

do $$
declare
  inc uuid;
  re uuid;
  pra uuid := pg_temp.agent('Payment Release Assistant');
begin
  if exists (select 1 from public.incidents where title = 'Same supplier invoice paid twice') then return; end if;

  perform pg_temp.hist_incident('Chat Refund Agent', 'lucy.grant@northbridge.demo', 74, 10.2, 'Refunded interest as well as fees', 'high',
    'Customers who asked about a fee were also refunded the overdraft interest on the same statement.',
    '{"containment":"Refund limit lowered to £50 while the rule was fixed; refunds over £50 went to a person.","impact":"14 customers refunded £3,180 of interest that the goodwill policy does not cover.","customers_affected":14,"financial_impact":3180,"financial_currency":"GBP","personal_data":"no","root_cause_category":"instructions","root_cause":"The refund instructions said ''charges'', which the agent read as fees and interest.","remediation":"Instructions now list the fee codes that may be refunded; tests added for interest lines."}',
    'closed', 'omar.farouk@northbridge.demo', array[95, 2900, 4400, 5900]);

  perform pg_temp.hist_incident('Collections Outreach Agent', 'aisha.rahman@northbridge.demo', 61, 21.4, 'Reminder texts sent after 9pm', 'medium',
    'A batch of arrears reminders went out between 21:05 and 21:40, outside permitted contact hours.',
    '{"containment":"Outreach paused for the evening; the batch queue cleared.","impact":"212 customers received a text after 9pm.","customers_affected":212,"personal_data":"yes","root_cause_category":"integration","root_cause":"The SMS provider changed its scheduling API to UTC; the agent''s cut-off was still in UK time.","remediation":"Cut-off computed in Europe/London; the provider change is now on the integration checklist."}',
    'closed', 'sara.haddad@northbridge.demo', array[40, 1500, 2950, 4300]);

  perform pg_temp.hist_incident('Reconciliation Exceptions Agent', 'tom.becker@northbridge.demo', 47, 15.1, 'Cleared a break against the wrong nostro account', 'high',
    'A £9,400 break on the EUR nostro was cleared against a USD entry with the same reference.',
    '{"containment":"The clearing was reversed and the agent''s matches re-checked for the week.","impact":"One break wrongly cleared for a day; no customer or financial loss.","customers_affected":0,"financial_impact":0,"financial_currency":"GBP","personal_data":"no","root_cause_category":"data_quality","root_cause":"Two banks reused the same payment reference; the match did not compare currencies.","remediation":"Matches now require the same currency and account."}',
    'closed', 'omar.farouk@northbridge.demo', array[120, 1600, 2900, 4320]);

  -- The kill switch: a Critical incident suspends the Payment Release Assistant at once (task 4.9). Its owner is emailed to
  -- switch it off, the incident is closed, and two approvers switch it back on (task 4.6).
  inc := pg_temp.hist_incident('Payment Release Assistant', 'james.whitfield@northbridge.demo', 33, 11.3, 'Same supplier invoice paid twice', 'critical',
    'Invoice CP-22918 from Calder Logistics (£412,600) was released twice, eight minutes apart.',
    '{"containment":"Agent suspended by the kill switch; the second payment recalled through SWIFT the same afternoon.","impact":"One duplicate payment of £412,600, recalled in full the next day.","customers_affected":0,"financial_impact":412600,"financial_currency":"GBP","personal_data":"no","root_cause_category":"integration","root_cause":"SAP timed out after accepting the first release; the agent''s retry did not check whether the payment already existed.","remediation":"Releases now carry an idempotency key that SAP checks; retries look the payment up first."}',
    'closed', 'ravi.menon@northbridge.demo', array[18, 1450, 2700, 2880]);
  perform pg_temp.act_as('james.whitfield@northbridge.demo');
  re := public.request_reactivation(pra, 'Duplicate-payment fix deployed and tested; the incident is closed.');
  perform pg_temp.act_as('daniel.okafor@northbridge.demo');
  perform public.approve_reactivation(re, 'Tested in the payment sandbox.');
  if (select status from public.agent_reactivations where id = re) = 'pending' then
    perform pg_temp.act_as('ravi.menon@northbridge.demo');
    perform public.approve_reactivation(re, 'Agreed.');
  end if;
  perform pg_temp.act_as_system();

  perform pg_temp.hist_incident('Chat Refund Agent', 'lucy.grant@northbridge.demo', 19, 13.6, 'Goodwill refund for a customer outside the criteria', 'low',
    'A customer with two fees in three months was refunded; the criteria need three in one month.',
    '{"containment":"Refund left in place (£30); the case was sampled with ten others, all correct.","impact":"One refund of £30 outside policy.","customers_affected":1,"financial_impact":30,"financial_currency":"GBP","personal_data":"no","root_cause_category":"model_error","root_cause":"The agent counted fees across two statements as one month.","remediation":"Fee count now taken from the core banking report, not read from statements."}',
    'closed', 'omar.farouk@northbridge.demo', array[60, 1440, 2000, 2900]);

  -- Resolved; closure asked of Ravi Menon, waiting for him.
  perform pg_temp.hist_incident('Complaint Classifier', 'admin@northbridge.demo', 9, 9.8, 'Regulatory complaints classified as general enquiries', 'medium',
    'A sample check found 6 of 50 complaints about mis-sold insurance labelled as general enquiries, so they missed the 8-week regulatory clock.',
    '{"containment":"Every complaint from the last 30 days re-read by the team; 23 moved to the regulatory queue.","impact":"23 regulatory complaints started their clock late, by 1 to 9 days.","customers_affected":23,"personal_data":"yes","root_cause_category":"model_error","root_cause":"The categories were changed in Salesforce and the agent''s examples were not updated.","remediation":"Examples updated; a weekly sample of 50 is checked by a person."}',
    'closure', 'ravi.menon@northbridge.demo', array[180, 2880, 4000, null]);

  -- The one open incident (two days old, past its time limit): the Affordability Checker, whose review is also overdue.
  perform pg_temp.hist_incident('Affordability Checker', 'aisha.rahman@northbridge.demo', 2, 9.1, 'Declined applications using last year''s income rule', 'high',
    'Underwriters found personal loan applications declined against the 2025 minimum-income rule, which changed on 1 November.',
    '{}', 'open', null, '{}'::int[]);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Changes made on the agent platform outside Control Tower (the drift report).
-- ---------------------------------------------------------------------------
do $$
declare conn constant text := 'Northbridge Agent Platform (simulated)';
begin
  if exists (select 1 from public.drift_events) then return; end if;
  perform pg_temp.act_as_system();
  insert into public.drift_events (agent_id, kind, expected, observed, actor, action, result, detected_at) values
    (pg_temp.agent('KYC Refresh Agent'), 'owner_changed', format('Owner on %s: Tom Becker (tom.becker@northbridge.demo)', conn),
      format('Owner on %s: Grace Mensah (grace.mensah@northbridge.demo)', conn), format('g.mensah on %s (outside Control Tower)', conn),
      'Recorded; everyone with access checked against the data-authority matrix', 'Everyone with access is authorised', pg_temp.hist_at(58, 14.2)),
    (pg_temp.agent('Sanctions Pre-screener'), 'sharing_changed', 'Shared with Financial Crime Operations (role not known)',
      'Shared with Financial Crime Operations (role not known), Ana Costa (Sales Associate)', format('d.price on %s (outside Control Tower)', conn),
      'Recorded; everyone with access checked against the data-authority matrix', 'Without authority: Ana Costa (Sales Associate) for Restricted, Personal. Alert raised',
      pg_temp.hist_at(41, 10.6)),
    (pg_temp.agent('Sanctions Pre-screener'), 'sharing_changed', 'Shared with Financial Crime Operations (role not known), Ana Costa (Sales Associate)',
      'Shared with Financial Crime Operations (role not known)', format('d.price on %s (outside Control Tower)', conn),
      'Recorded; everyone with access checked against the data-authority matrix', 'Everyone with access is authorised', pg_temp.hist_at(40, 9.3)),
    (pg_temp.agent('Loan Document Extractor'), 'capabilities_changed', 'Tools: Read documents, Fill extraction form · Data: Document store · Kinds: Personal',
      'Tools: Read documents, Fill extraction form, Send email · Data: Document store · Kinds: Personal', 'Unknown, outside Control Tower',
      'Registry updated from the platform; data authority checked again', 'Registry updated; everyone with access is authorised', pg_temp.hist_at(24, 16.8)),
    (pg_temp.agent('Reconciliation Exceptions Agent'), 'blocked_outside', format('Active on %s (Live in Control Tower)', conn), format('Blocked on %s', conn),
      format('ops.support on %s (outside Control Tower)', conn), 'Recorded',
      'No change in Control Tower: the agent stays Live here; its platform is stopping it', pg_temp.hist_at(11, 8.4));
end $$;

-- ---------------------------------------------------------------------------
-- 4. Autonomy changes agreed at review (on the record in the audit trail).
-- ---------------------------------------------------------------------------
do $$ begin
  if (select autonomy_level from public.agents where name = 'Ops Ticket Triage') <> 4 then return; end if;
  -- Live agents change only through review; an admin records the outcome.
  perform pg_temp.act_as('admin@northbridge.demo');
  perform set_config('act.reason', 'A priority-1 ticket was routed to the wrong team; it now acts alone only up to 500 tickets a day, and asks above that.', true);
  update public.agents set autonomy_level = 3, volume_threshold = 500 where name = 'Ops Ticket Triage';
  perform set_config('act.reason', 'Three months of extractions checked by case handlers with no corrections; may now fill the form itself.', true);
  update public.agents set autonomy_level = 2 where name = 'Loan Document Extractor';
  perform set_config('act.reason', '', true);
  perform pg_temp.act_as_system();
end $$;

-- ---------------------------------------------------------------------------
-- 5. Move it all back to when it happened, and tidy what was raised along the way.
-- ---------------------------------------------------------------------------
do $$
declare m record;
begin
  if not exists (select 1 from hist_requests) then return; end if;
  select * into m from hist_marks;

  -- Only the dates move: the guards and audit triggers are off for these few statements.
  alter table public.action_requests disable trigger user;
  alter table public.action_request_approvals disable trigger user;
  alter table public.incidents disable trigger user;
  alter table public.incident_updates disable trigger user;
  alter table public.agent_suspensions disable trigger user;
  alter table public.agent_reactivations disable trigger user;
  alter table public.agent_reactivation_approvals disable trigger user;
  alter table public.agent_enforcements disable trigger user;

  update public.action_requests r
     set requested_at = h.at, routed_at = case when r.routed_at is not null then h.at end,
         escalated_at = null, sla_escalated_at = null,
         due_at = case when r.due_at is not null then h.at + make_interval(mins => coalesce(r.sla_minutes, 1440)) end,
         decided_at = case when r.decided_at is not null then h.at + make_interval(mins => h.minutes) end
    from hist_requests h where h.id = r.id;
  -- Four-eyes: the first approval about two thirds of the way, the second at the decision.
  update public.action_request_approvals x
     set approved_at = h.at + make_interval(mins => case when x.approver_id = r.decided_by then h.minutes else (h.minutes * 2) / 3 end)
    from hist_requests h join public.action_requests r on r.id = h.id where h.id = x.request_id;

  update public.incidents i
     set opened_at = h.at, occurred_at = h.at - interval '25 minutes', due_at = h.at + make_interval(mins => i.sla_minutes),
         contained_at = case when i.contained_at is not null then h.at + make_interval(mins => h.contained) end,
         resolved_at = case when i.resolved_at is not null then h.at + make_interval(mins => h.resolved) end,
         closure_requested_at = case when i.closure_requested_at is not null then h.at + make_interval(mins => h.closure) end,
         closed_at = case when i.closed_at is not null then h.at + make_interval(mins => h.closed) end,
         updated_at = h.at + make_interval(mins => coalesce(h.closed, h.closure, h.resolved, h.contained, 5))
    from hist_incidents h where h.id = i.id;
  -- The case notes, spread in order from opening to the last step.
  update public.incident_updates u
     set created_at = i.opened_at + (coalesce(i.closed_at, i.closure_requested_at, i.resolved_at, i.contained_at, i.opened_at + interval '5 minutes') - i.opened_at)
                      * ((x.n - 1)::numeric / greatest(x.total - 1, 1))
    from (select id, incident_id, row_number() over (partition by incident_id order by id) n, count(*) over (partition by incident_id) total
            from public.incident_updates) x
    join public.incidents i on i.id = x.incident_id
   where u.id = x.id and i.id in (select id from hist_incidents);

  -- The kill switch: suspended a minute after the report, its owner emailed to switch it off, switched back on two days later.
  update public.agent_suspensions s set requested_at = i.opened_at + interval '1 minute', suspended_at = i.opened_at + interval '1 minute'
    from public.incidents i where i.id = s.incident_id and i.id in (select id from hist_incidents);
  update public.agent_enforcements e
     set status = 'done', attempts = 1, created_at = s.suspended_at, claimed_at = s.suspended_at + interval '2 seconds',
         finished_at = s.suspended_at + interval '4 seconds', next_attempt_at = s.suspended_at,
         detail = case e.method when 'webhook' then 'Stop request delivered (HTTP 200)'
                       when 'email' then format('Emailed %s, asking them to switch it off', split_part(e.target, ' (', 1)) else coalesce(e.detail, 'Done') end
    from public.agent_suspensions s where s.id = e.suspension_id and s.incident_id in (select id from hist_incidents) and e.reactivation_id is null;
  update public.agent_reactivations r
     set requested_at = i.closed_at + interval '20 minutes', decided_at = i.closed_at + interval '26 hours'
    from public.agent_suspensions s join public.incidents i on i.id = s.incident_id
   where s.id = r.suspension_id and i.id in (select id from hist_incidents);
  update public.agent_reactivation_approvals x
     set approved_at = r.decided_at - case when x.approver_id = r.decided_by then interval '0' else interval '3 hours' end
    from public.agent_reactivations r where r.id = x.reactivation_id and r.decided_at < now() - interval '7 days';
  update public.agent_enforcements e
     set status = 'done', attempts = 1, created_at = r.decided_at, claimed_at = r.decided_at + interval '2 seconds',
         finished_at = r.decided_at + interval '4 seconds', next_attempt_at = r.decided_at,
         detail = case e.method when 'webhook' then 'Resume request delivered (HTTP 200)'
                       when 'email' then format('Emailed %s, saying it may be switched back on', split_part(e.target, ' (', 1)) else coalesce(e.detail, 'Done') end
    from public.agent_reactivations r where r.id = e.reactivation_id and r.decided_at < now() - interval '7 days';

  alter table public.action_requests enable trigger user;
  alter table public.action_request_approvals enable trigger user;
  alter table public.incidents enable trigger user;
  alter table public.incident_updates enable trigger user;
  alter table public.agent_suspensions enable trigger user;
  alter table public.agent_reactivations enable trigger user;
  alter table public.agent_reactivation_approvals enable trigger user;
  alter table public.agent_enforcements enable trigger user;

  -- Nobody is emailed or alerted about the past; the bell starts clean. Alerts raised for the history (for example the
  -- data-authority one) are closed; the open incident keeps its own case.
  delete from public.push_outbox where id > m.push;
  delete from public.email_outbox where id > m.email;
  delete from public.notifications where id > m.note;
  delete from public.callback_outbox where id > m.callback;
  update public.alerts set resolved_at = now() where resolved_at is null and not (id = any (m.alerts));
  delete from hist_requests;
end $$;

commit;
