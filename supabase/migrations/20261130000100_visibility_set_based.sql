-- Keeping the live Approvals list inside its 2 seconds (task 2.5), 18 Nov.
-- On the work-in-progress database the list's re-read took about a second, and the live list 2.06 and 2.3 s on phone.
-- Most of it was visible_agent_ids() (used by the rules of 18 tables since task 4.10): it called in_approver_scope and
-- is_assigned_to_agent once per agent, each with its own small lookups (460 ms for 262 agents for an approver).
-- Now the person's facts (active, sees everything, approver, their departments, the agents assigned to them) are worked
-- out once per read and every agent is matched against them in one go (39 ms for the same 262 agents). The rules are
-- exactly the same; the tests of tasks 1.x, 2.x and 4.10 check them.

-- The departments the signed-in person approves for (only while they hold the approver role), and the agents with a
-- request assigned to them (any status). Each is worked out once per read where it is used as "in (select ...)".
create function public.my_approver_departments() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select s.department_id from public.approver_scopes s where s.user_id = auth.uid() and public.has_role('approver')
$$;
create function public.my_assigned_agent_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct r.agent_id from public.action_requests r where r.assigned_to = auth.uid()
$$;

create or replace function public.visible_agent_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() uid, public.is_active_user() active, public.sees_everything() all_)
  select a.id from public.agents a, me
   where me.active
     and (me.all_
          or me.uid in (a.business_owner_id, a.technical_owner_id, a.created_by)
          or a.department_id in (select public.my_approver_departments())
          or a.id in (select public.my_assigned_agent_ids()))
$$;

-- The agents table keeps its per-row rule (a new agent must be visible to whoever just created it), with the same
-- person-level facts worked out once per read.
alter policy "agents visible in scope" on public.agents
  using ((select public.is_active_user()) and ((select public.sees_everything())
         or (select auth.uid()) in (business_owner_id, technical_owner_id, created_by)
         or department_id in (select public.my_approver_departments())
         or id in (select public.my_assigned_agent_ids())));

revoke execute on function public.my_approver_departments(), public.my_assigned_agent_ids() from public, anon;
grant execute on function public.my_approver_departments(), public.my_assigned_agent_ids() to authenticated;
