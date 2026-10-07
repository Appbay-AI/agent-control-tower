-- Who can approve this agent's registration: approvers whose scope covers its department,
-- excluding its owners and creator (segregation of duties). Anyone who can see the agent may ask,
-- so an owner knows whose queue their submission is in. Returns names only, never permissions.
create function public.approvers_for(p_agent_id uuid)
returns table (id uuid, full_name text, job_title text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, p.job_title
  from public.agents a
  join public.approver_scopes s on s.department_id = a.department_id
  join public.user_roles r on r.user_id = s.user_id and r.role = 'approver'
  join public.profiles p on p.id = s.user_id and p.is_active
  where a.id = p_agent_id
    and public.can_see_agent(p_agent_id)
    and p.id is distinct from a.business_owner_id
    and p.id is distinct from a.technical_owner_id
    and p.id is distinct from a.created_by
  order by p.full_name
$$;

revoke execute on function public.approvers_for(uuid) from public, anon, authenticated;
grant execute on function public.approvers_for(uuid) to authenticated;
