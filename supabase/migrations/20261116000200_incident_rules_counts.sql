-- Task 4.9 (follow-up): the forced-review reason names the real count ("switched back on outside Control Tower 8 times"),
-- not just the threshold. Same rules as 20261116000100_incident_rules.sql.

create or replace function public.incident_repeat_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
  codes text;
begin
  if tg_op = 'UPDATE' and new.root_cause_category is not distinct from old.root_cause_category then return null; end if;
  -- Switched back on outside Control Tower 3 times or more.
  select count(*), string_agg(incident_code, ', ' order by opened_at) into n, codes from public.incidents
   where agent_id = new.agent_id and source = 'reconciliation' and opened_at > now() - interval '90 days';
  if n >= 3 then
    perform public.force_review(new.agent_id, format('switched back on outside Control Tower %s times in 90 days (%s)', n, codes));
    return null;
  end if;
  -- The same root cause twice or more.
  if new.root_cause_category is not null then
    select count(*), string_agg(incident_code, ', ' order by opened_at) into n, codes from public.incidents
     where agent_id = new.agent_id and root_cause_category = new.root_cause_category and opened_at > now() - interval '90 days';
    if n >= 2 then
      perform public.force_review(new.agent_id, format('the same root cause %s in 90 days (%s: %s)',
        case n when 2 then 'twice' else n || ' times' end, replace(initcap(new.root_cause_category::text), '_', ' '), codes));
      return null;
    end if;
  end if;
  -- Any 3 incidents or more.
  select count(*), string_agg(incident_code, ', ' order by opened_at) into n, codes from public.incidents
   where agent_id = new.agent_id and opened_at > now() - interval '90 days';
  if n >= 3 then
    perform public.force_review(new.agent_id, format('%s incidents in 90 days (%s)', n, codes));
  end if;
  return null;
end $$;
