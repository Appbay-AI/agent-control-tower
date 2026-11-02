-- Task 3.6: the dual registry (R1.5, R1.6). An agent that comes from a platform has two kinds of fields:
--   * platform fields, which the platform owns: name, description, systems it uses, data it touches. They follow the
--     platform on every sync and cannot be edited in Control Tower (change them on the platform);
--   * governance fields, which Control Tower owns: owners, department, purpose, allowed and forbidden actions,
--     autonomy, limits, risk tier, regulations, credentials, review dates. These stay editable as before.
-- Agents registered by hand or through the API have no platform, so every field stays editable.
-- The registry shows each agent's source: the platform's name ("auto"), API or Manual.

-- What the platform says, in registry terms (the same mapping task 3.5 used when it created discovered agents).
create function public.platform_systems(p_details jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array(
    select distinct s from (
      select jsonb_array_elements_text(case when jsonb_typeof(p_details -> 'dataSources') = 'array' then p_details -> 'dataSources' else '[]' end) s
      union all
      select jsonb_array_elements_text(case when jsonb_typeof(p_details -> 'tools') = 'array' then p_details -> 'tools' else '[]' end)) x
    where btrim(s) <> '' order by 1), '{}')
$$;

create function public.platform_classifications(p_details jsonb) returns public.data_classification[]
language sql immutable set search_path = '' as $$
  select coalesce(array(
    select distinct d::public.data_classification
      from jsonb_array_elements_text(case when jsonb_typeof(p_details -> 'dataClassifications') = 'array' then p_details -> 'dataClassifications' else '[]' end) d
     where d in ('public', 'internal', 'confidential', 'restricted', 'personal')
     order by 1), '{}')
$$;

-- ---------------------------------------------------------------------------
-- Platform fields cannot be edited, except by the sync itself.
-- ---------------------------------------------------------------------------
create function public.agents_platform_fields_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_platform text;
begin
  if coalesce(current_setting('act.platform_sync', true), '') = 'on' then return new; end if;
  if (new.name, new.description, new.systems_accessed, new.data_classifications)
     is not distinct from (old.name, old.description, old.systems_accessed, old.data_classifications) then
    return new;
  end if;
  select c.name into v_platform
    from public.platform_agents pa join public.platform_connections c on c.id = pa.connection_id
   where pa.agent_id = new.id
   limit 1;
  if v_platform is not null then
    raise exception '%''s name, description, systems and data come from %. Change them there; the next sync brings them here.',
      old.agent_code, v_platform using errcode = 'check_violation';
  end if;
  return new;
end $$;
-- Named to run after agents_edit_guard and agents_lifecycle_guard (same-event triggers run in name order).
create trigger agents_platform_fields_guard before update on public.agents
  for each row execute function public.agents_platform_fields_guard();

-- The sync may change platform fields on agents that are no longer Proposed (edits are otherwise frozen then).
create or replace function public.agents_edit_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('act.allow_lifecycle', true), '') = 'on' or public.has_role('admin') then
    return new;
  end if;
  if coalesce(current_setting('act.platform_sync', true), '') = 'on'
     and (to_jsonb(new) - array['name', 'description', 'systems_accessed', 'data_classifications', 'updated_at'])
         = (to_jsonb(old) - array['name', 'description', 'systems_accessed', 'data_classifications', 'updated_at']) then
    return new;
  end if;
  if old.status <> 'proposed' then
    raise exception 'Only Proposed agents can be edited; % agents change through review', old.status
      using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.agent_registrations where agent_id = old.id and status = 'pending') then
    raise exception 'This agent is waiting for approval and cannot be edited' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Every sync (and every new link) brings the platform fields into the registry entry. Retired entries are left alone.
-- ---------------------------------------------------------------------------
create function public.platform_agents_to_registry() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_platform text;
  prev_actor text := current_setting('act.actor_type', true);
  prev_reason text := current_setting('act.reason', true);
begin
  if new.agent_id is null then return null; end if;
  if tg_op = 'UPDATE' and new.agent_id is not distinct from old.agent_id and new.details = old.details then return null; end if;
  select name into v_platform from public.platform_connections where id = new.connection_id;

  perform set_config('act.platform_sync', 'on', true);
  perform set_config('act.actor_type', 'integration', true);
  perform set_config('act.reason', format('Updated from %s (%s)', v_platform, new.external_id), true);
  update public.agents a
     set name = left(new.name, 200),
         description = nullif(new.details ->> 'description', ''),
         systems_accessed = public.platform_systems(new.details),
         data_classifications = public.platform_classifications(new.details)
   where a.id = new.agent_id and a.status <> 'retired'
     and (a.name, a.description, a.systems_accessed, a.data_classifications)
         is distinct from (left(new.name, 200), nullif(new.details ->> 'description', ''),
                           public.platform_systems(new.details), public.platform_classifications(new.details));
  perform set_config('act.platform_sync', '', true);
  perform set_config('act.actor_type', coalesce(prev_actor, ''), true);
  perform set_config('act.reason', coalesce(prev_reason, ''), true);
  return null;
end $$;
create trigger platform_agents_to_registry after insert or update of agent_id, details on public.platform_agents
  for each row execute function public.platform_agents_to_registry();

-- ---------------------------------------------------------------------------
-- Where each agent comes from, for the registry's source badge (only agents the caller can see).
-- ---------------------------------------------------------------------------
create function public.agent_platform_sources() returns table (agent_id uuid, platform text, external_id text, status text, missing_since timestamptz)
language sql stable security definer set search_path = '' as $$
  select pa.agent_id, c.name, pa.external_id, pa.status, pa.missing_since
    from public.platform_agents pa join public.platform_connections c on c.id = pa.connection_id
   where pa.agent_id is not null and public.can_see_agent(pa.agent_id)
$$;

revoke execute on function public.agents_platform_fields_guard(), public.platform_agents_to_registry(),
  public.agent_platform_sources() from public, anon;
revoke execute on function public.agents_platform_fields_guard(), public.platform_agents_to_registry() from authenticated;
grant execute on function public.agent_platform_sources() to authenticated;
grant execute on function public.platform_systems(jsonb), public.platform_classifications(jsonb) to authenticated;
