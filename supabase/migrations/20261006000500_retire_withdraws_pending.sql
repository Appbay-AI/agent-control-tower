-- Retiring an agent withdraws any registration still waiting for approval,
-- so approvers are never asked to approve an agent that no longer exists.

create or replace function public.withdraw_pending_registrations() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'retired' and old.status <> 'retired' then
    update public.agent_registrations
    set status = 'rejected', decided_at = now(), decision_reason = 'Withdrawn: the agent was retired'
    where agent_id = new.id and status = 'pending';
  end if;
  return null;
end $$;

create trigger agents_withdraw_on_retire after update of status on public.agents
  for each row execute function public.withdraw_pending_registrations();

revoke execute on function public.withdraw_pending_registrations() from public, anon, authenticated;
