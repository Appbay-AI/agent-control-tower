-- DEMO DATA ONLY. Clears every agent and its history so the demo bank can be reloaded from scratch.
-- Keeps logins, profiles, roles, approver scopes, departments and integration keys.
-- This is the only place the audit log is ever cleared: its guards are switched off, the synthetic
-- history removed, and the guards switched back on, all in one transaction. Never run on real data.

begin;
alter table public.audit_events disable trigger audit_events_no_update;
alter table public.audit_events disable trigger audit_events_no_truncate;

truncate public.alerts, public.agent_reviews, public.registration_decisions, public.agent_registrations,
         public.agent_api_keys, public.agents, public.audit_events
  restart identity;
alter sequence public.agent_code_seq restart;

alter table public.audit_events enable trigger audit_events_no_update;
alter table public.audit_events enable trigger audit_events_no_truncate;
commit;
