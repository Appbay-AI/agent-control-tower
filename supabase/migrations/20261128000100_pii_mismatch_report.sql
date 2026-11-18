-- Task 6.7 (R5.4): the personal-data access mismatch report. Done when: mismatches are listed with roles.
-- pii_mismatch_report(personal_only): every person who can use an agent that handles data their role (job title) is
-- not authorised for, from the data-authority check of task 4.8 (agent_authority_findings, kept up to date whenever
-- owners, sharing, job titles, data kinds or the matrix change). For each: the person, their role, their roles in the
-- Control Tower, how they come to have access (owner, or owner or shared on the platform), the agent and its data, the
-- kinds of data they lack authority for, which roles are authorised for those, and since when. By default only
-- mismatches involving personal data; with personal_only = false, every kind. Retired agents are left out.
-- Admins, executives and auditors only (the people who see every agent).

create function public.pii_mismatch_report(p_personal_only boolean default true) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_user() and public.sees_everything()) then
    raise exception 'Only admins, executives and auditors can see the access mismatch report' using errcode = 'insufficient_privilege';
  end if;

  return (
    with m as (
      select f.*, a.agent_code, a.name agent_name, a.status agent_status, a.data_classifications,
             (select name from public.departments where id = a.department_id) department,
             p.id profile_id, p.is_active
        from public.agent_authority_findings f
        join public.agents a on a.id = f.agent_id
        left join public.profiles p on lower(p.email) = lower(f.email)
       where a.status <> 'retired' and (not coalesce(p_personal_only, true) or 'personal' = any (f.missing)))
    select jsonb_build_object(
      'at', now(),
      'personal_only', coalesce(p_personal_only, true),
      'total', (select count(*) from m),
      'people', (select count(distinct lower(email)) from m),
      'agents', (select count(distinct agent_id) from m),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object(
          'agent_id', agent_id, 'agent', agent_code || ' ' || agent_name, 'agent_status', agent_status, 'department', department,
          'data', to_jsonb(data_classifications),
          'email', email, 'name', name, 'role', job_title,
          'ct_roles', (select coalesce(jsonb_agg(r.role order by r.role), '[]') from public.user_roles r where r.user_id = m.profile_id),
          'ct_user', profile_id is not null, 'active', is_active,
          'how', to_jsonb(how), 'missing', to_jsonb(missing),
          -- Roles authorised for every kind this person lacks ("*" = everyone).
          'authorised_roles', (select coalesce(jsonb_agg(t order by t), '[]') from (
              select d.job_title t from public.data_authority d
               where d.classification = any (m.missing)
               group by d.job_title having count(distinct d.classification) = cardinality(m.missing)) x),
          'since', first_seen_at)
          order by first_seen_at desc, agent_code, name), '[]') from m),
      'by_role', (select coalesce(jsonb_agg(jsonb_build_object('role', coalesce(job_title, ''), 'mismatches', n, 'people', p) order by n desc, job_title), '[]')
                    from (select job_title, count(*) n, count(distinct lower(email)) p from m group by job_title) x),
      'by_kind', (select coalesce(jsonb_object_agg(k, n), '{}') from (select k::text, count(*) n from m, unnest(missing) k group by k) x),
      -- The matrix, for reading the report: which roles may see each kind.
      'matrix', (select coalesce(jsonb_object_agg(classification, roles), '{}') from (
          select classification::text, jsonb_agg(job_title order by job_title) roles from public.data_authority group by classification) x)
    ));
end $$;

revoke execute on function public.pii_mismatch_report(boolean) from public, anon;
grant execute on function public.pii_mismatch_report(boolean) to authenticated;
