-- Phase 2, task 2.5: the approvals list updates on its own. A new agent action (or a new agent waiting for approval)
-- appears on an approver's screen within seconds, without a reload.
--
-- How: Supabase Realtime "Postgres Changes". The tables below are added to the supabase_realtime publication; the app
-- subscribes and re-reads the list when anything changes. Realtime checks each change against the subscriber's
-- row-level security before sending it, so people are only told about rows they could already read
-- (https://supabase.com/docs/guides/realtime/postgres-changes). The existing select policies and grants
-- (action_requests: can_see_agent; agent_registrations / registration_decisions: visible with the agent) apply unchanged.
--
-- Free plan limits (https://supabase.com/docs/guides/realtime/limits, https://supabase.com/pricing):
-- 200 concurrent connections, 100 messages per second, 2 million messages per month. Far above demo use.
--
-- Safe to run more than once, and on a project where someone already switched a table on in the dashboard.

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['action_requests', 'agent_registrations', 'registration_decisions'] loop
    if not exists (select 1 from pg_catalog.pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
