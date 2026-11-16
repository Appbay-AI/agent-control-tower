-- Task 4.10 (found while checking the demo end to end): screens had become slow as the data grew.
-- Every read checked "may this person see this agent?" row by row (can_see_agent per row, several lookups each), so a
-- read of the approvals on waiting requests took 0.5 s on average and up to 8 s on the test site (1,200 requests).
-- Now the set of agents a person may see is worked out ONCE per read (visible_agent_ids, a hashed sub-plan) and each
-- row is a lookup in it. Who sees what is unchanged: visible_agent_ids is the same rule as can_see_agent.

-- The same rule as can_see_agent (20261016000100_routing_matrix.sql): an active person who sees everything (admin,
-- executive, auditor), owns or created the agent, approves for its department, or has a request from it assigned.
create function public.visible_agent_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select a.id from public.agents a
   where (select public.is_active_user())
     and ((select public.sees_everything())
          or (select auth.uid()) in (a.business_owner_id, a.technical_owner_id, a.created_by)
          or public.in_approver_scope(a.department_id)
          or exists (select 1 from public.action_requests r where r.agent_id = a.id and r.assigned_to = (select auth.uid())))
$$;
revoke execute on function public.visible_agent_ids() from public, anon;
grant execute on function public.visible_agent_ids() to authenticated;

-- "Has a request from it assigned" for any status (the existing index covers only waiting requests).
create index action_requests_assigned_agent on public.action_requests (assigned_to, agent_id) where assigned_to is not null;

-- The agents table keeps its per-row rule (a new agent must be visible to whoever just created it, before any list of
-- visible agents could include it), with the person-level checks worked out once per read.
alter policy "agents visible in scope" on public.agents
  using ((select public.is_active_user()) and ((select public.sees_everything())
         or (select auth.uid()) in (business_owner_id, technical_owner_id, created_by)
         or public.in_approver_scope(department_id)
         or public.is_assigned_to_agent(id)));

alter policy "action requests visible with agent" on public.action_requests using (agent_id in (select public.visible_agent_ids()));
alter policy "approvals visible with the request" on public.action_request_approvals
  using (request_id in (select r.id from public.action_requests r where r.agent_id in (select public.visible_agent_ids())));
alter policy "findings visible with the agent" on public.agent_authority_findings using (agent_id in (select public.visible_agent_ids()));
alter policy "contact visible with agent" on public.agent_contact using (agent_id in (select public.visible_agent_ids()));
alter policy "enforcement visible with the agent" on public.agent_enforcements using (agent_id in (select public.visible_agent_ids()));
alter policy "logs visible with agent" on public.agent_logs using (agent_id in (select public.visible_agent_ids()));
alter policy "reactivation approvals visible with the agent" on public.agent_reactivation_approvals using (agent_id in (select public.visible_agent_ids()));
alter policy "reactivations visible with the agent" on public.agent_reactivations using (agent_id in (select public.visible_agent_ids()));
alter policy "registrations visible with agent" on public.agent_registrations using (agent_id in (select public.visible_agent_ids()));
alter policy "reviews visible with agent" on public.agent_reviews using (agent_id in (select public.visible_agent_ids()));
alter policy "suspensions visible with the agent" on public.agent_suspensions using (agent_id in (select public.visible_agent_ids()));
alter policy "alerts visible with agent" on public.alerts using (agent_id in (select public.visible_agent_ids()));
alter policy "drift visible with the agent" on public.drift_events using (agent_id in (select public.visible_agent_ids()));
alter policy "decisions visible with agent" on public.registration_decisions using (agent_id in (select public.visible_agent_ids()));
alter policy "audit visible" on public.audit_events
  using ((select public.sees_everything()) or agent_id in (select public.visible_agent_ids()));
alter policy "platform agents visible with their registry agent" on public.platform_agents
  using ((select public.sees_everything()) or agent_id in (select public.visible_agent_ids()));
alter policy "incidents visible with the agent or to their owner" on public.incidents
  using (agent_id in (select public.visible_agent_ids()) or owner_id = (select auth.uid()));
alter policy "incident log visible with the incident" on public.incident_updates
  using (incident_id in (select i.id from public.incidents i
                          where i.agent_id in (select public.visible_agent_ids()) or i.owner_id = (select auth.uid())));
