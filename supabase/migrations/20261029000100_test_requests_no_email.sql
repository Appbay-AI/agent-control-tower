-- Fix (task 2.7): requests the automated tests mark as tests sent real emails to Resend's test inbox, about 7 per
-- test run, and those count towards Resend's free daily limit (100 a day). On 26 Oct, 93 of them used 80% of it,
-- which would have stopped real approval emails, the demo's included.
-- Now: details.test = true → no email is sent; the request page shows "Not sent: test request".
--      details.test = "email" → one email to Resend's test inbox (used by the one e2e test that checks sending).
create or replace function public.action_requests_alert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  escalated boolean := new.escalated_at is not null and tg_op = 'UPDATE';
  test text := coalesce(new.details ->> 'test', '');
begin
  if new.status <> 'pending' then return null; end if;
  if tg_op = 'UPDATE' and new.assigned_to is not distinct from old.assigned_to then return null; end if;
  insert into public.push_outbox (user_id, kind, request_id, title, body, url)
  select d, 'action_request', new.id,
         case when escalated then 'Escalated to you · ' else 'Approval needed · ' end || new.request_code,
         public.request_alert_body(new),
         '/approvals/requests/' || new.id
  from public.request_deciders(new) d;
  insert into public.email_outbox (user_id, request_id, kind, is_test, sent_at, result)
  select d, new.id, case when escalated then 'escalated' else 'new' end, test in ('true', 'email'),
         case when test = 'true' then now() end,
         case when test = 'true' then 'Not sent: test request' end
  from public.request_deciders(new) d;
  return null;
end $$;
