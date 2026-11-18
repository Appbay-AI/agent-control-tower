-- Task 6.8: the audit view. Done when: any event can be found and exported.
-- audit_search(...) finds audit entries by words (in the summary, reason, action, record type, the people's and
-- agents' names, or "#123" for an entry number), time, kind of actor, person, agent, record type and action, newest
-- first, a page at a time (p_before_seq: the entry number to continue below). It runs as the signed-in person, so the
-- audit trail's own rule decides what they see: admins, executives and auditors everything, others the entries of the
-- agents they can see. The same search gives the export (up to 10,000 entries, with the before and after values and
-- each entry's hashes), and audit_record_export puts each export on the record.

create function public.audit_search(
  p_query text default null, p_from date default null, p_to date default null, p_actor_type text default null,
  p_actor uuid default null, p_agent uuid default null, p_entity text default null, p_action text default null,
  p_before_seq bigint default null, p_limit integer default 100, p_full boolean default false
) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
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
    with hits as (
      select e.*, p.full_name actor_name, a.agent_code, a.name agent_name
        from public.audit_events e
        left join public.profiles p on p.id = e.actor_id
        left join public.agents a on a.id = e.agent_id
       where (seq_wanted is null or e.seq = seq_wanted)
         and (t0 is null or e.occurred_at >= t0) and (t1 is null or e.occurred_at < t1)
         and (p_actor_type is null or e.actor_type = p_actor_type)
         and (p_actor is null or e.actor_id = p_actor)
         and (p_agent is null or e.agent_id = p_agent)
         and (p_entity is null or e.entity_type = p_entity)
         and (p_action is null or e.action = p_action)
         and (q is null or concat_ws(' ', e.summary, e.reason, e.action, e.entity_type, p.full_name, a.agent_code, a.name, e.entity_id::text)
                             ilike '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%')),
    page as (select * from hits where p_before_seq is null or seq < p_before_seq order by seq desc limit lim)
    select jsonb_build_object(
      'total', (select count(*) from hits),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object(
          'seq', seq, 'at', occurred_at, 'actor_type', actor_type, 'actor_id', actor_id, 'actor', actor_name,
          'action', action, 'entity_type', entity_type, 'entity_id', entity_id,
          'agent_id', agent_id, 'agent', case when agent_id is not null then agent_code || ' ' || agent_name end,
          'summary', summary, 'reason', reason, 'before', before, 'after', after, 'hash', hash, 'prev_hash', prev_hash)
          order by seq desc), '[]') from page),
      'next_before_seq', (select case when count(*) = lim then min(seq) end from page),
      'limit', lim)
  );
end $$;

-- Exporting is itself on the record: who exported, how many entries, and with which search.
create function public.audit_record_export(p_filters jsonb, p_rows integer, p_format text) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare s bigint;
begin
  if not public.is_active_user() then
    raise exception 'Sign in to export the audit trail' using errcode = 'insufficient_privilege';
  end if;
  if p_format not in ('csv', 'json') then raise exception 'Unknown format' using errcode = 'invalid_parameter_value'; end if;
  insert into public.audit_events (actor_id, actor_type, action, entity_type, summary, after)
  values (auth.uid(), 'user', 'audit.exported', 'audit_events',
          format('Audit trail exported as %s: %s entries', upper(p_format), p_rows),
          jsonb_build_object('filters', coalesce(p_filters, '{}'::jsonb), 'rows', p_rows, 'format', p_format))
  returning seq into s;
  return s;
end $$;

-- The record types and actions in the trail, for the search filters (what the person can see).
create function public.audit_facets() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'entities', (select coalesce(jsonb_agg(entity_type order by entity_type), '[]') from (select distinct entity_type from public.audit_events) x),
    'actions', (select coalesce(jsonb_agg(action order by action), '[]') from (select distinct action from public.audit_events) x))
$$;

create index if not exists audit_events_entity_idx on public.audit_events (entity_type, seq desc);
create index if not exists audit_events_actor_idx on public.audit_events (actor_id, seq desc);

revoke execute on function public.audit_search(text, date, date, text, uuid, uuid, text, text, bigint, integer, boolean),
  public.audit_record_export(jsonb, integer, text), public.audit_facets() from public, anon;
grant execute on function public.audit_search(text, date, date, text, uuid, uuid, text, text, bigint, integer, boolean),
  public.audit_record_export(jsonb, integer, text), public.audit_facets() to authenticated;
