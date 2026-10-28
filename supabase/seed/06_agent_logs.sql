-- Demo for the agent log and the silent-agent check (task 2.11). Run after 05_action_requests.sql.
-- 1. The Cash Forecast Agent is watched (its owner asked to be told if it is quiet for more than an hour). It logged a
--    connection error about six hours ago and has not been heard from since, so it is flagged as silent.
-- 2. The Payment Release Assistant's log tells the story behind the £2m Hartwell request.
-- Times are relative to the (re)seed. Idempotent: does nothing if the Cash Forecast Agent already has log entries.
do $$
declare
  cash uuid := pg_temp.agent('Cash Forecast Agent');
  pra uuid := pg_temp.agent('Payment Release Assistant');
  hartwell uuid;
  asked_at timestamptz;
begin
  if cash is null or exists (select 1 from public.agent_logs where agent_id = cash) then return; end if;

  perform pg_temp.act_as('james.whitfield@northbridge.demo');
  perform public.set_agent_silence_limit(cash, 60);
  perform pg_temp.act_as_system();

  insert into public.agent_logs (agent_id, level, event, message, details, occurred_at, received_at)
  select cash, l, e, m, d, now() - make_interval(mins => ago), now() - make_interval(mins => ago)
  from (values
    ('info', 'forecast.started', 'Started the daily liquidity forecast run', null::jsonb, 1460),
    ('info', 'forecast.published', 'Published the 13-week cash forecast to the treasury desk', '{"accounts": 214, "currencies": ["GBP", "EUR", "USD"]}'::jsonb, 1442),
    ('info', 'forecast.started', 'Started the intraday refresh', null, 420),
    ('warning', 'source.slow', 'Treasury data warehouse answered slowly (41 s); continuing', '{"source": "TDW", "seconds": 41}'::jsonb, 395),
    ('error', 'source.unreachable', 'Lost the connection to the treasury data warehouse; retrying in 5 minutes', '{"source": "TDW", "attempt": 1}'::jsonb, 372)
  ) as v(l, e, m, d, ago);
  update public.agent_contact
     set last_seen_at = now() - interval '372 minutes', last_seen_via = 'log entry', watch_from = now() - interval '30 days'
   where agent_id = cash;
  perform public.check_silent_agents();

  if pra is null then return; end if;
  select id, requested_at into hartwell, asked_at from public.action_requests where agent_id = pra and amount = 2000000 order by requested_at desc limit 1;
  asked_at := coalesce(asked_at, now());
  -- Seconds relative to the moment it asked: before (negative) and after.
  insert into public.agent_logs (agent_id, level, event, message, details, request_id, occurred_at, received_at)
  select pra, l, e, m, d, case when linked then hartwell end, asked_at + make_interval(secs => off_s), asked_at + make_interval(secs => off_s)
  from (values
    ('info', 'invoice.matched', 'Invoice HS-48817 from Hartwell Steel Ltd matches purchase order PO-2026-0912 and the goods receipt',
     '{"invoice": "HS-48817", "purchase_order": "PO-2026-0912", "amount": 2000000, "currency": "GBP"}'::jsonb, false, -40),
    ('info', 'sanctions.clear', 'Sanctions screening of the beneficiary came back clear', '{"beneficiary_bank": "Barclays, London"}'::jsonb, false, -25),
    ('warning', 'limit.exceeded', '£2,000,000 is above my £250,000 limit, so I asked the Control Tower for approval', null, true, 0),
    ('info', 'approval.waiting', 'Waiting for the decision; nothing will be released until it is approved', null, true, 1)
  ) as v(l, e, m, d, linked, off_s);
end $$;
