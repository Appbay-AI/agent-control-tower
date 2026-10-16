-- DEMO DATA ONLY. Clears every agent and its history so the demo bank can be reloaded from scratch.
-- Keeps logins, departments and integration keys; routing rules go back to the two demo rules (04_routing.sql). Demo personas get back their original roles, departments
-- and active status (02_demo_bank.sql re-grants them); people added through the Users screen are kept.
-- This is the only place the audit log is ever cleared: its guards are switched off, the synthetic
-- history removed, and the guards switched back on, all in one transaction. Never run on real data.

begin;
-- Undo anything done to the personas during a demo (before the truncate, so it leaves no audit rows).
update public.profiles set is_active = true, must_change_password = false where email like '%@northbridge.demo';
update auth.users set banned_until = null where email like '%@northbridge.demo';
delete from public.approver_scopes where user_id in (select id from public.profiles where email like '%@northbridge.demo');
delete from public.user_roles r using public.profiles p
 where p.id = r.user_id and p.email like '%@northbridge.demo'
   and not (p.email = 'admin@northbridge.demo' and r.role = 'admin');

alter table public.audit_events disable trigger audit_events_no_update;
alter table public.audit_events disable trigger audit_events_no_truncate;

truncate public.routing_rules, public.action_requests, public.alerts, public.agent_reviews, public.registration_decisions,
         public.agent_registrations, public.agent_api_keys, public.agents, public.audit_events
  restart identity;
alter sequence public.agent_code_seq restart;
alter sequence public.action_request_code_seq restart;

alter table public.audit_events enable trigger audit_events_no_update;
alter table public.audit_events enable trigger audit_events_no_truncate;
commit;
