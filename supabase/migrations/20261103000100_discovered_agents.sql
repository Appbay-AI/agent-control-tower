-- Task 3.5: agents found on a platform enter the registry as Discovered, and must pass the Phase 1 registration
-- approval before they are governed (R1.4). Their owner and the admins are alerted.
--
-- After each sync, for every agent the platform lists that is not yet linked to a registry entry:
--   * if the registry already has a (not retired) agent with the same name and the same business owner, and that agent
--     is not linked to another platform agent, the two are linked (for example NAP-002 Invoice Matcher, which Appbay
--     registers by hand);
--   * otherwise a registry entry is created: status Proposed, registration source "discovered", with what the platform
--     said (name, description, owner if the email matches an active person, department if the name matches, data
--     sources and tools as systems accessed, data classifications). Purpose is left blank on purpose: someone must
--     write it. The usual rules then apply: a business owner, a purpose and a department before submitting; an
--     approver (two for Critical) before Approved; Live only after that (agents_lifecycle_guard). A discovered agent
--     therefore cannot reach Live unapproved.
--   * an "agent_discovered" alert is raised on the entry ("... is not registered"); it clears when the agent is
--     approved or retired. Each admin (the designated person until alert routing, task 5.2) and each matched owner gets
--     one phone alert per sync. Alert emails come with Phase 5.
-- Entries created here are audited as the integration ("Found on <platform> as NAP-001").

alter type public.alert_kind add value if not exists 'agent_discovered';

alter table public.push_outbox drop constraint push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check check (kind in ('action_request', 'test', 'agent_discovered'));

-- Owners (and approvers in scope) also see the platform record of agents they can see.
drop policy "platform agents visible to those who see everything" on public.platform_agents;
create policy "platform agents visible with their registry agent" on public.platform_agents for select to authenticated
  using (public.sees_everything() or (agent_id is not null and public.can_see_agent(agent_id)));

create function public.platform_agents_govern(p_connection uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.platform_connections;
  pa public.platform_agents;
  v_owner uuid;
  v_dept uuid;
  v_existing public.agents;
  v_new public.agents;
  new_ids uuid[] := '{}';
  linked integer := 0;
begin
  select * into c from public.platform_connections where id = p_connection;
  if not found then return jsonb_build_object('registered', 0, 'linked', 0); end if;
  perform set_config('act.actor_type', 'integration', true);

  for pa in
    select * from public.platform_agents
     where connection_id = c.id and agent_id is null and missing_since is null
     order by external_id
     for update
  loop
    v_owner := null; v_dept := null;
    if pa.owner_email is not null then
      select id into v_owner from public.profiles
       where lower(email) = lower(pa.owner_email) and is_active order by created_at limit 1;
    end if;
    if pa.department is not null then
      select id into v_dept from public.departments where lower(name) = lower(btrim(pa.department)) limit 1;
    end if;

    select a.* into v_existing from public.agents a
     where v_owner is not null and a.business_owner_id = v_owner and lower(a.name) = lower(pa.name) and a.status <> 'retired'
       and not exists (select 1 from public.platform_agents x where x.agent_id = a.id)
     order by a.created_at limit 1;

    if v_existing.id is not null then
      update public.platform_agents set agent_id = v_existing.id where id = pa.id returning * into pa;
      linked := linked + 1;
      perform public.platform_sync_audit(pa, 'platform_agents.linked',
        format('%s %s on %s is %s in the registry', pa.external_id, pa.name, c.name, v_existing.agent_code));
    else
      perform set_config('act.reason', format('Found on %s as %s', c.name, pa.external_id), true);
      insert into public.agents (name, description, origin, framework, business_owner_id, department_id, purpose_statement,
                                 systems_accessed, data_classifications, autonomy_level, risk_tier, registration_source, created_by)
      values (
        left(pa.name, 200),
        nullif(pa.details ->> 'description', ''),
        'internal',
        (case c.kind when 'appian_simulator' then 'appian' else 'other' end)::public.agent_framework,
        v_owner, v_dept, '',
        array(select distinct s from (
                select jsonb_array_elements_text(case when jsonb_typeof(pa.details -> 'dataSources') = 'array' then pa.details -> 'dataSources' else '[]' end) s
                union all
                select jsonb_array_elements_text(case when jsonb_typeof(pa.details -> 'tools') = 'array' then pa.details -> 'tools' else '[]' end)) x
              where btrim(s) <> '' order by 1),
        array(select distinct d::public.data_classification
                from jsonb_array_elements_text(case when jsonb_typeof(pa.details -> 'dataClassifications') = 'array' then pa.details -> 'dataClassifications' else '[]' end) d
               where d in ('public', 'internal', 'confidential', 'restricted', 'personal')),
        1, 'medium', 'discovered', null)
      returning * into v_new;
      perform set_config('act.reason', '', true);
      update public.platform_agents set agent_id = v_new.id where id = pa.id;
      insert into public.alerts (kind, agent_id, message)
      values ('agent_discovered', v_new.id,
              format('%s was found on %s as %s and is not registered%s. Name a business owner, write its purpose and submit it for approval, or retire it.',
                     v_new.agent_code, c.name, pa.external_id,
                     case when v_owner is null then ' (no owner in Control Tower)' else '' end))
      on conflict do nothing;
      new_ids := new_ids || v_new.id;
    end if;
  end loop;

  -- One phone alert per person per sync: each admin about all of them, each owner about theirs.
  if cardinality(new_ids) > 0 then
    insert into public.push_outbox (user_id, kind, title, body, url)
    select p.id, 'agent_discovered',
           case when count(*) = 1 then 'Agent found · not registered' else count(*) || ' agents found · not registered' end,
           case when count(*) = 1 then format('%s (%s) is on %s but not registered in Control Tower.', min(a.name), min(a.agent_code), c.name)
                else format('%s agents on %s are not registered in Control Tower: %s.', count(*), c.name,
                            string_agg(a.name, ', ' order by a.agent_code)) end,
           case when count(*) = 1 then '/agents/' || (array_agg(a.id))[1] else '/agents' end
      from public.profiles p
      join public.agents a on a.id = any (new_ids)
     where p.is_active
       and (a.business_owner_id = p.id or exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin'))
     group by p.id;
  end if;

  perform set_config('act.actor_type', '', true);
  return jsonb_build_object('registered', cardinality(new_ids), 'linked', linked);
end $$;

-- The "not registered" alert clears once the agent is approved (or retired: retire_agent clears every alert).
create function public.agents_discovered_cleared() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'proposed' and new.status <> 'proposed' then
    update public.alerts set resolved_at = now()
     where agent_id = new.id and kind = 'agent_discovered' and resolved_at is null;
  end if;
  return null;
end $$;
create trigger agents_discovered_cleared after update of status on public.agents
  for each row execute function public.agents_discovered_cleared();

create or replace function public.platform_sync_apply(p_token text, p_agents jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.platform_jobs;
  c public.platform_connections;
  a jsonb;
  old public.platform_agents;
  r public.platform_agents;
  ids text[] := '{}';
  v_id text;
  v_status text;
  found_new integer := 0;
  status_changed integer := 0;
  came_back integer := 0;
  gone integer := 0;
  governed jsonb;
begin
  select * into j from public.platform_jobs where token_hash = public.secret_hash(coalesce(p_token, '')) for update;
  if not found or j.kind <> 'sync' or j.claimed_at is null or j.finished_at is not null
     or j.claimed_at < now() - interval '10 minutes' then
    raise exception 'Invalid or used job token' using errcode = 'invalid_authorization_specification';
  end if;
  if jsonb_typeof(p_agents) is distinct from 'array' then
    raise exception 'agents must be a list' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_agents) > 5000 then
    raise exception 'More than 5,000 agents in one sync' using errcode = 'check_violation';
  end if;
  select * into c from public.platform_connections where id = j.connection_id;

  for a in select value from jsonb_array_elements(p_agents) loop
    v_id := a ->> 'externalId';
    v_status := a ->> 'status';
    if coalesce(v_id, '') = '' or coalesce(a ->> 'name', '') = '' or v_status is null or v_status not in ('active', 'blocked') then
      raise exception 'Agent % lacks an id, a name or a status of active or blocked', coalesce(v_id, '?') using errcode = 'check_violation';
    end if;
    if v_id = any (ids) then
      raise exception 'Agent % is listed twice', v_id using errcode = 'check_violation';
    end if;
    ids := ids || v_id;

    select * into old from public.platform_agents where connection_id = c.id and external_id = v_id for update;
    if not found then
      insert into public.platform_agents (connection_id, external_id, name, status, owner_email, owner_name, department, environment, details)
      values (c.id, v_id, a ->> 'name', v_status, a -> 'owner' ->> 'email', a -> 'owner' ->> 'name', a ->> 'department',
              a ->> 'environment', a)
      returning * into r;
      found_new := found_new + 1;
      perform public.platform_sync_audit(r, 'platform_agents.discovered',
        format('%s %s found on %s%s', v_id, r.name, c.name,
               case when r.owner_email is null then ' (no owner)' else '' end
               || case when v_status = 'blocked' then ' (blocked there)' else '' end));
    else
      update public.platform_agents
         set name = a ->> 'name', status = v_status, owner_email = a -> 'owner' ->> 'email', owner_name = a -> 'owner' ->> 'name',
             department = a ->> 'department', environment = a ->> 'environment', details = a,
             last_seen_at = now(), missing_since = null,
             status_seen_at = case when old.status = v_status then old.status_seen_at else now() end
       where id = old.id
      returning * into r;
      if old.missing_since is not null then
        came_back := came_back + 1;
        perform public.platform_sync_audit(r, 'platform_agents.back', format('%s %s is listed on %s again', v_id, r.name, c.name));
      end if;
      if old.status <> v_status then
        status_changed := status_changed + 1;
        perform public.platform_sync_audit(r, 'platform_agents.status_changed',
          format('%s %s is %s on %s (was %s)%s', v_id, r.name, v_status, c.name, old.status,
                 coalesce(' by ' || nullif(a ->> 'statusChangedBy', ''), '')));
      end if;
    end if;
  end loop;

  -- Listed before, not now: missing at source.
  for r in
    update public.platform_agents set missing_since = now()
     where connection_id = c.id and missing_since is null and not (external_id = any (ids))
    returning *
  loop
    gone := gone + 1;
    perform public.platform_sync_audit(r, 'platform_agents.missing', format('%s %s is no longer listed on %s', r.external_id, r.name, c.name));
  end loop;

  -- Task 3.5: every agent listed that is not governed yet enters the registry (or is linked to its existing entry).
  governed := public.platform_agents_govern(c.id);

  return jsonb_build_object('agents', jsonb_array_length(p_agents), 'new', found_new, 'status_changed', status_changed,
                            'registered', governed -> 'registered', 'linked', governed -> 'linked',
                            'back', came_back, 'missing', gone,
                            'blocked', (select count(*) from public.platform_agents where connection_id = c.id and missing_since is null and status = 'blocked'));
end $$;

revoke execute on function public.platform_agents_govern(uuid), public.agents_discovered_cleared() from public, anon, authenticated;

-- For the agent's page: where it was found, for anyone who can see the agent (connection names are admin-only otherwise).
create function public.platform_record_for_agent(p_agent uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('platform', c.name, 'kind', c.kind, 'external_id', pa.external_id, 'status', pa.status,
                            'environment', pa.environment, 'owner_email', pa.owner_email, 'department', pa.department,
                            'first_seen_at', pa.first_seen_at, 'last_seen_at', pa.last_seen_at, 'missing_since', pa.missing_since)
    from public.platform_agents pa join public.platform_connections c on c.id = pa.connection_id
   where pa.agent_id = p_agent and public.can_see_agent(p_agent)
   order by pa.last_seen_at desc limit 1
$$;
revoke execute on function public.platform_record_for_agent(uuid) from public, anon;
grant execute on function public.platform_record_for_agent(uuid) to authenticated;
