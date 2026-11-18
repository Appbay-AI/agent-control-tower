-- Task 7.4 (loading speed): the Audit trail page took 4.7 s to open on the test database (23,000 entries): the search
-- gathered every matching entry with all its values (before and after) just to count them. Now it gathers only the
-- matching entry numbers, counts those, and reads the values for the one page shown. Same answers (db-tests/audit_search).
-- Keeps its own 30-second limit (20261130000300).
create or replace function public.audit_search(
  p_query text default null, p_from date default null, p_to date default null, p_actor_type text default null,
  p_actor uuid default null, p_agent uuid default null, p_entity text default null, p_action text default null,
  p_before_seq bigint default null, p_limit integer default 100, p_full boolean default false
) returns jsonb
language plpgsql stable security invoker set search_path = '' set statement_timeout = '30s' as $$
declare
  q text := nullif(btrim(coalesce(p_query, '')), '');
  seq_wanted bigint;
  lim integer := least(greatest(coalesce(p_limit, 100), 1), case when p_full then 10000 else 500 end);
  t0 timestamptz := case when p_from is not null then p_from::timestamp at time zone 'UTC' end;
  t1 timestamptz := case when p_to is not null then (p_to + 1)::timestamp at time zone 'UTC' end;
begin
  if not public.is_active_user() then
    raise exception 'Sign in to search the audit trail' using errcode = 'insufficient_privilege';
  end if;
  if q ~ '^#?[0-9]+$' then seq_wanted := ltrim(q, '#')::bigint; q := null; end if;

  return (
    with hits as materialized (
      select e.seq
        from public.audit_events e
        left join public.profiles p on q is not null and p.id = e.actor_id
        left join public.agents a on q is not null and a.id = e.agent_id
       where (seq_wanted is null or e.seq = seq_wanted)
         and (t0 is null or e.occurred_at >= t0) and (t1 is null or e.occurred_at < t1)
         and (p_actor_type is null or e.actor_type = p_actor_type)
         and (p_actor is null or e.actor_id = p_actor)
         and (p_agent is null or e.agent_id = p_agent)
         and (p_entity is null or e.entity_type = p_entity)
         and (p_action is null or e.action = p_action)
         and (q is null or concat_ws(' ', e.summary, e.reason, e.action, e.entity_type, p.full_name, a.agent_code, a.name, e.entity_id::text)
                             ilike '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%')),
    page_seqs as (select seq from hits where p_before_seq is null or seq < p_before_seq order by seq desc limit lim),
    page as (
      select e.*, p.full_name actor_name, a.agent_code, a.name agent_name
        from page_seqs s
        join public.audit_events e on e.seq = s.seq
        left join public.profiles p on p.id = e.actor_id
        left join public.agents a on a.id = e.agent_id)
    select jsonb_build_object(
      'total', (select count(*) from hits),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object(
          'seq', seq, 'at', occurred_at, 'actor_type', actor_type, 'actor_id', actor_id, 'actor', actor_name,
          'action', action, 'entity_type', entity_type, 'entity_id', entity_id,
          'agent_id', agent_id, 'agent', case when agent_id is not null then agent_code || ' ' || agent_name end,
          'summary', summary, 'reason', reason, 'before', before, 'after', after, 'hash', hash, 'prev_hash', prev_hash)
          order by seq desc), '[]') from page),
      'next_before_seq', (select case when count(*) = lim then min(seq) end from page_seqs),
      'limit', lim)
  );
end $$;
