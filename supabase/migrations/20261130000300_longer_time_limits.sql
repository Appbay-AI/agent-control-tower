-- 18 Nov: two one-click requests get longer than the usual 8-second limit for signed-in people's requests.
-- The evidence pack (task 6.1) reads a period's records, checks the whole audit trail and digests the pack: about 3 s on
-- a quiet work-in-progress database, but on the preview test, with other tests running, it was stopped at 8 s
-- ("canceling statement due to statement timeout"). The audit trail export (task 6.8) can read up to 10,000 entries.
-- Supabase applies a function's own statement_timeout to calls through its API (at most 60 s); everything else keeps 8 s.
alter function public.evidence_pack(date, date) set statement_timeout = '60s';
alter function public.audit_search(text, date, date, text, uuid, uuid, text, text, bigint, integer, boolean) set statement_timeout = '30s';
