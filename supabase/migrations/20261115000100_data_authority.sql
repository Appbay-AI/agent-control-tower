-- Task 4.8: the data-authority matrix (R3.5). Which roles (job titles) may see which kinds of data, and a check of
-- everyone who can use each agent against it: the agent's business and technical owners in Control Tower, and its
-- owner and the people it is shared with on its platform. Changes to an agent's owner or sharing on the platform are
-- put on the record ("outside Control Tower, actor unknown") and checked. A person who can use an agent that handles
-- data their role is not authorised for is a finding: an open alert on the agent and, when the person is new to the
-- findings, a phone alert to every admin and the agent's business owner and an audit record.
-- The check runs again when an agent's owners or data kinds change, when someone's job title changes, when the
-- platform's sharing or owner changes, and when the matrix changes. Retired agents are not checked.

alter type public.alert_kind add value if not exists 'data_authority';

-- ---------------------------------------------------------------------------
-- The matrix: one row per (job title, data kind) that is allowed. "*" = everyone.
-- ---------------------------------------------------------------------------
create table public.data_authority (
  job_title text not null check (length(btrim(job_title)) between 1 and 200),
  classification public.data_classification not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (job_title, classification)
);
alter table public.data_authority enable row level security;
create policy "data authority readable" on public.data_authority for select to authenticated using (public.is_active_user());
revoke all on public.data_authority from anon, authenticated;
grant select on public.data_authority to authenticated;
create trigger audit_change after insert or delete on public.data_authority for each row execute function public.audit_table_change();

-- A starting matrix for the Northbridge demo bank (admins change it on the Users page).
insert into public.data_authority (job_title, classification)
select t, c::public.data_classification from (values
  ('*', 'public'), ('*', 'internal'),
  ('Customer Service Agent', 'personal'), ('Customer Service Agent', 'confidential'),
  ('Payments Analyst', 'confidential'),
  ('Credit Analyst', 'confidential'), ('Credit Analyst', 'restricted'),
  ('Treasury Analyst', 'confidential'),
  ('KYC Officer', 'personal'), ('KYC Officer', 'restricted')
) v(t, c)
union all
-- Leaders who own agents may see every kind.
select t, c from (values ('Automation Engineering Lead'), ('Chief Risk Officer'), ('Control Tower administrator'),
  ('Customer Service Director'), ('Head of Credit Risk'), ('Head of Operational Risk'), ('Head of Payments Product'),
  ('Internal Audit Manager'), ('Lending Product Lead'), ('Operations Risk Manager'), ('Payments Risk Lead')) l(t)
cross join (values ('confidential'::public.data_classification), ('restricted'), ('personal')) k(c)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Everyone who can use an agent, with their role and how they come to have access.
-- ---------------------------------------------------------------------------
create function public.agent_people(p_agent uuid)
returns table (email text, name text, job_title text, how text[])
language sql stable security definer set search_path = '' as $$
  with a as (select * from public.agents where id = p_agent),
  raw as (
    select lower(p.email) email, p.full_name name, p.job_title, 'Business owner' how, 1 ord
      from a join public.profiles p on p.id = a.business_owner_id where p.email is not null
    union all
    select lower(p.email), p.full_name, p.job_title, 'Technical owner', 2
      from a join public.profiles p on p.id = a.technical_owner_id where p.email is not null
    union all
    select lower(pa.details -> 'owner' ->> 'email'), coalesce(pa.details -> 'owner' ->> 'name', pr.full_name), pr.job_title,
           format('Owner on %s', c.name), 3
      from public.platform_agents pa join public.platform_connections c on c.id = pa.connection_id
      left join public.profiles pr on lower(pr.email) = lower(pa.details -> 'owner' ->> 'email')
     where pa.agent_id = p_agent and pa.missing_since is null and jsonb_typeof(pa.details -> 'owner') = 'object'
    union all
    select lower(s ->> 'email'), coalesce(s ->> 'name', pr.full_name), coalesce(nullif(s ->> 'jobTitle', ''), pr.job_title),
           format('Shared on %s', c.name), 4
      from public.platform_agents pa join public.platform_connections c on c.id = pa.connection_id
      cross join lateral jsonb_array_elements(case when jsonb_typeof(pa.details -> 'sharedWith') = 'array' then pa.details -> 'sharedWith' else '[]' end) s
      left join public.profiles pr on lower(pr.email) = lower(s ->> 'email')
     where pa.agent_id = p_agent and pa.missing_since is null and coalesce(s ->> 'email', '') <> ''
  )
  select email, (array_agg(name order by ord) filter (where name is not null))[1],
         (array_agg(job_title order by ord) filter (where job_title is not null))[1],
         array_agg(how order by ord)
    from raw group by email
$$;

-- Each person with the data kinds of the agent their role is not authorised for (empty = all fine). Internal.
create function public.agent_access_compute(p_agent uuid)
returns table (email text, name text, job_title text, how text[], missing public.data_classification[])
language sql stable security definer set search_path = '' as $$
  select p.email, p.name, p.job_title, p.how,
         coalesce(array(select k from unnest((select data_classifications from public.agents where id = p_agent)) k
                         where not exists (select 1 from public.data_authority d
                                            where d.classification = k and (d.job_title = '*' or d.job_title = p.job_title))
                         order by k), '{}')
    from public.agent_people(p_agent) p
   order by p.how[1], p.name
$$;

-- The same, for the agent's page: only for people who can see the agent.
create function public.agent_access(p_agent uuid)
returns table (email text, name text, job_title text, how text[], missing public.data_classification[])
language sql stable security definer set search_path = '' as $$
  select * from public.agent_access_compute(p_agent) where public.can_see_agent(p_agent)
$$;

-- ---------------------------------------------------------------------------
-- Findings: the people who can use an agent without authority for some of its data, as of the last check.
-- ---------------------------------------------------------------------------
create table public.agent_authority_findings (
  agent_id uuid not null references public.agents (id) on delete cascade,
  email text not null,
  name text,
  job_title text,
  how text[] not null,
  missing public.data_classification[] not null,
  first_seen_at timestamptz not null default now(),
  primary key (agent_id, email)
);
alter table public.agent_authority_findings enable row level security;
create policy "findings visible with the agent" on public.agent_authority_findings for select to authenticated
  using (public.can_see_agent(agent_id));
revoke all on public.agent_authority_findings from anon, authenticated;
grant select on public.agent_authority_findings to authenticated;

alter table public.push_outbox drop constraint push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check
  check (kind in ('action_request', 'test', 'agent_discovered', 'suspension', 'enforcement', 'incident', 'reactivation',
                  'reconciliation', 'data_authority'));

create function public.authority_label(k public.data_classification[]) returns text
language sql immutable set search_path = '' as $$
  select string_agg(initcap(x::text), ', ' order by x) from unnest(k) x
$$;

-- Check one agent; p_notify = tell people about findings that are new (off for the first fill).
create function public.authority_recheck(p_agent uuid, p_notify boolean default true) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  f record;
  still text[];
  fresh text[] := '{}';
  msg text;
  n integer;
begin
  select * into a from public.agents where id = p_agent;
  if not found then return 0; end if;
  if a.status = 'retired' then
    delete from public.agent_authority_findings where agent_id = p_agent;
    update public.alerts set resolved_at = now() where agent_id = p_agent and kind = 'data_authority' and resolved_at is null;
    return 0;
  end if;

  select coalesce(array_agg(x.email), '{}') into still from public.agent_access_compute(p_agent) x where cardinality(x.missing) > 0;
  delete from public.agent_authority_findings g where g.agent_id = p_agent and g.email <> all (still);
  for f in select * from public.agent_access_compute(p_agent) x where cardinality(x.missing) > 0 loop
    update public.agent_authority_findings set name = f.name, job_title = f.job_title, how = f.how, missing = f.missing
     where agent_id = p_agent and email = f.email;
    if not found then
      insert into public.agent_authority_findings (agent_id, email, name, job_title, how, missing)
      values (p_agent, f.email, f.name, f.job_title, f.how, f.missing);
      fresh := fresh || format('%s (%s)', coalesce(f.name, f.email), coalesce(f.job_title, 'role not known'));
      if p_notify then
        insert into public.audit_events (actor_id, actor_type, action, entity_type, entity_id, agent_id, summary, reason)
        values (null, 'system', 'agents.access_without_authority', 'agents', p_agent, p_agent,
                format('%s (%s, %s) can use %s, which handles %s data; that role is not authorised for it',
                       coalesce(f.name, f.email), coalesce(f.job_title, 'role not known'), array_to_string(f.how, ', '),
                       a.agent_code, public.authority_label(f.missing)),
                'Data-authority check');
      end if;
    end if;
  end loop;

  select count(*) into n from public.agent_authority_findings where agent_id = p_agent;
  if n = 0 then
    update public.alerts set resolved_at = now() where agent_id = p_agent and kind = 'data_authority' and resolved_at is null;
    return 0;
  end if;
  select format('%s can be used by %s without authority for its data: %s.', a.agent_code,
                case when n = 1 then 'someone' else n || ' people' end,
                string_agg(format('%s (%s) for %s', coalesce(g.name, g.email), coalesce(g.job_title, 'role not known'),
                                  public.authority_label(g.missing)), '; ' order by g.first_seen_at, g.email))
    into msg from public.agent_authority_findings g where g.agent_id = p_agent;
  update public.alerts set message = left(msg, 1000) where agent_id = p_agent and kind = 'data_authority' and resolved_at is null;
  if not found then
    insert into public.alerts (kind, agent_id, message) values ('data_authority', p_agent, left(msg, 1000)) on conflict do nothing;
  end if;

  if p_notify and cardinality(fresh) > 0 then
    insert into public.push_outbox (user_id, kind, title, body, url)
    select p.id, 'data_authority', format('No authority · %s', a.agent_code),
           left(format('%s can use %s without authority for its data. Check the Data authority matrix or remove their access.',
                       array_to_string(fresh, ', '), a.name), 300), '/agents/' || a.id
      from public.profiles p
     where p.is_active and (p.id = a.business_owner_id
            or exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin'));
  end if;
  return n;
end $$;

create function public.authority_recheck_all() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer := 0; x uuid;
begin
  for x in select id from public.agents where status <> 'retired' loop
    n := n + public.authority_recheck(x);
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- When to check
-- ---------------------------------------------------------------------------
-- The platform's owner or sharing changed (a sync): put the change on the record, then check.
create function public.platform_agents_sharing_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  added text;
  removed text;
  owner_before text;
  owner_after text;
  code text;
  conn text;
begin
  if new.agent_id is null then return null; end if;
  if tg_op = 'UPDATE' and new.agent_id is not distinct from old.agent_id
     and new.details -> 'sharedWith' is not distinct from old.details -> 'sharedWith'
     and new.details -> 'owner' is not distinct from old.details -> 'owner'
     and new.missing_since is not distinct from old.missing_since then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.agent_id is not distinct from old.agent_id then
    select string_agg(format('%s (%s)', coalesce(s ->> 'name', s ->> 'email'), coalesce(s ->> 'jobTitle', 'role not known')), ', ')
      into added from jsonb_array_elements(coalesce(new.details -> 'sharedWith', '[]')) s
     where not exists (select 1 from jsonb_array_elements(coalesce(old.details -> 'sharedWith', '[]')) o where lower(o ->> 'email') = lower(s ->> 'email'));
    select string_agg(coalesce(s ->> 'name', s ->> 'email'), ', ')
      into removed from jsonb_array_elements(coalesce(old.details -> 'sharedWith', '[]')) s
     where not exists (select 1 from jsonb_array_elements(coalesce(new.details -> 'sharedWith', '[]')) o where lower(o ->> 'email') = lower(s ->> 'email'));
    owner_before := coalesce(old.details -> 'owner' ->> 'name', old.details -> 'owner' ->> 'email', 'nobody');
    owner_after := coalesce(new.details -> 'owner' ->> 'name', new.details -> 'owner' ->> 'email', 'nobody');
    if added is not null or removed is not null or owner_before <> owner_after then
      select agent_code into code from public.agents where id = new.agent_id;
      select name into conn from public.platform_connections where id = new.connection_id;
      insert into public.audit_events (actor_id, actor_type, action, entity_type, entity_id, agent_id, summary, reason)
      values (null, 'system', 'platform_agents.sharing_changed', 'platform_agents', new.id, new.agent_id,
              left(concat_ws('; ', format('%s on %s as %s', code, conn, new.external_id),
                             case when owner_before <> owner_after then format('owner %s → %s', owner_before, owner_after) end,
                             case when added is not null then 'shared with ' || added end,
                             case when removed is not null then 'no longer shared with ' || removed end)
                   || '. Changed outside Control Tower (actor unknown).', 1000),
              'Platform sync');
    end if;
  end if;
  perform public.authority_recheck(new.agent_id);
  if tg_op = 'UPDATE' and old.agent_id is not null and old.agent_id is distinct from new.agent_id then
    perform public.authority_recheck(old.agent_id);
  end if;
  return null;
end $$;
create trigger platform_agents_sharing_changed after insert or update on public.platform_agents
  for each row execute function public.platform_agents_sharing_changed();

-- The agent's owners, data kinds or status changed in Control Tower.
create function public.agents_authority_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.business_owner_id is distinct from old.business_owner_id
     or new.technical_owner_id is distinct from old.technical_owner_id
     or new.data_classifications is distinct from old.data_classifications
     or (new.status = 'retired') <> (old.status = 'retired') then
    perform public.authority_recheck(new.id);
  end if;
  return null;
end $$;
create trigger agents_authority_changed after insert or update on public.agents
  for each row execute function public.agents_authority_changed();

-- Someone's job title changed: check the agents they can use.
create function public.profiles_authority_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare x uuid;
begin
  if new.job_title is not distinct from old.job_title then return null; end if;
  for x in
    select a.id from public.agents a where a.status <> 'retired' and (a.business_owner_id = new.id or a.technical_owner_id = new.id)
    union
    select pa.agent_id from public.platform_agents pa where pa.agent_id is not null
       and (lower(pa.details -> 'owner' ->> 'email') = lower(new.email)
            or exists (select 1 from jsonb_array_elements(coalesce(pa.details -> 'sharedWith', '[]')) s where lower(s ->> 'email') = lower(new.email)))
  loop
    perform public.authority_recheck(x);
  end loop;
  return null;
end $$;
create trigger profiles_authority_changed after update of job_title on public.profiles
  for each row execute function public.profiles_authority_changed();

-- The matrix changed: check every agent once per statement.
create function public.data_authority_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.authority_recheck_all();
  return null;
end $$;
create trigger data_authority_changed after insert or delete on public.data_authority
  for each statement execute function public.data_authority_changed();

-- ---------------------------------------------------------------------------
-- The matrix, changed by admins; and the job titles to offer.
-- ---------------------------------------------------------------------------
create function public.set_data_authority(p_job_title text, p_classification public.data_classification, p_allowed boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare t text := btrim(coalesce(p_job_title, ''));
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can change who may see which data' using errcode = 'insufficient_privilege';
  end if;
  if length(t) = 0 or length(t) > 200 then raise exception 'Give a job title' using errcode = 'check_violation'; end if;
  perform set_config('act.reason', format('%s %s data: %s', case when p_allowed then 'Allowed' else 'No longer allowed' end,
                                          initcap(p_classification::text), case when t = '*' then 'everyone' else t end), true);
  if p_allowed then
    insert into public.data_authority (job_title, classification, created_by) values (t, p_classification, auth.uid()) on conflict do nothing;
  else
    delete from public.data_authority where job_title = t and classification = p_classification;
  end if;
  perform set_config('act.reason', '', true);
end $$;

create function public.known_job_titles() returns table (job_title text, people integer)
language sql stable security definer set search_path = '' as $$
  select t, count(distinct e)::integer from (
    select job_title t, lower(email) e from public.profiles where is_active and job_title is not null
    union all
    select s ->> 'jobTitle', lower(s ->> 'email') from public.platform_agents pa,
           jsonb_array_elements(case when jsonb_typeof(pa.details -> 'sharedWith') = 'array' then pa.details -> 'sharedWith' else '[]' end) s
     where coalesce(s ->> 'jobTitle', '') <> '' and pa.missing_since is null
    union all
    select job_title, null from public.data_authority where job_title <> '*'
  ) x where public.is_active_user() group by t order by t
$$;

revoke execute on function public.agent_people(uuid), public.agent_access_compute(uuid), public.authority_recheck(uuid, boolean), public.authority_recheck_all(),
  public.platform_agents_sharing_changed(), public.agents_authority_changed(), public.profiles_authority_changed(),
  public.data_authority_changed() from public, anon, authenticated;
revoke execute on function public.agent_access(uuid), public.set_data_authority(text, public.data_classification, boolean),
  public.known_job_titles() from public, anon;
grant execute on function public.agent_access(uuid), public.set_data_authority(text, public.data_classification, boolean),
  public.known_job_titles() to authenticated;

-- First fill: today's findings, without phone alerts (they are not news).
do $$
declare x uuid;
begin
  for x in select id from public.agents where status <> 'retired' loop
    perform public.authority_recheck(x, false);
  end loop;
end $$;
