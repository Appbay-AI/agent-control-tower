-- 18 Nov (task 7.3): our site stores the results of its background work through these functions, as the anon role,
-- whose requests stop after 3 seconds. On a busy test database a reconciliation check that found an agent switched back
-- on outside Control Tower (incident, drift record, audit, alerts and emails in one go) was stopped at 3 s ("canceling
-- statement due to statement timeout"), so the re-block waited for the next 5-minute check. Each gets its own limit
-- (Supabase applies a function's own statement_timeout to calls through its API). Everything else keeps its limit.
-- Note: a later "create or replace" of one of these must repeat the setting.
alter function public.platform_reconcile_apply(text, jsonb) set statement_timeout = '30s';
alter function public.platform_sync_apply(text, jsonb) set statement_timeout = '30s';
alter function public.enforcement_report(text, jsonb) set statement_timeout = '30s';
alter function public.push_report(text, jsonb) set statement_timeout = '30s';
