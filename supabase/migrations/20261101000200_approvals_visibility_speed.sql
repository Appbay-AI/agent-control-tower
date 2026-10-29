-- Fix for task 2.10 (found while testing 3.2): reading approvals was slow, and got slower with every action request.
--
-- The rule "you see an approval if you can see its request" was written as EXISTS (select ... from action_requests ...).
-- Postgres planned that as: check visibility of EVERY action request, then keep the approvals whose request passed.
-- On dev, with 391 requests, Ravi's approvals list spent 0.67 s in the database (2+ s through the API), failing the
-- 2-second live-list target. Now each approval checks only its own request, through a function Postgres cannot unfold.
-- Who can see what does not change.

create function public.can_see_request(p_request_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.action_requests r where r.id = p_request_id and public.can_see_agent(r.agent_id))
$$;
revoke execute on function public.can_see_request(uuid) from public, anon;
grant execute on function public.can_see_request(uuid) to authenticated;

drop policy "approvals visible with the request" on public.action_request_approvals;
create policy "approvals visible with the request" on public.action_request_approvals for select to authenticated
  using (public.can_see_request(request_id));
