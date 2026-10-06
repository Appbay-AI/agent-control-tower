-- Phase 1, tasks 1.3, 1.5, 1.6, 1.7: roles, row-level security, registration workflow,
-- reviews and alerts, API keys. All business rules live in the database so no screen or API can skip them.

-- ---------------------------------------------------------------------------
-- Role helpers (security definer so policies can call them without recursion)
-- ---------------------------------------------------------------------------
create function public.has_role(p_role public.app_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles where user_id = auth.uid() and role = p_role)
$$;

create function public.sees_everything() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles
                 where user_id = auth.uid() and role in ('admin', 'executive', 'auditor'))
$$;

create function public.in_approver_scope(p_department_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_department_id is not null
     and public.has_role('approver')
     and exists (select 1 from public.approver_scopes where user_id = auth.uid() and department_id = p_department_id)
$$;

create function public.can_see_agent(p_agent_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.agents a
    where a.id = p_agent_id
      and (public.sees_everything()
           or auth.uid() in (a.business_owner_id, a.technical_owner_id, a.created_by)
           or public.in_approver_scope(a.department_id)))
$$;

create function public.is_agent_owner(p_agent_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.agents a
                 where a.id = p_agent_id and auth.uid() in (a.business_owner_id, a.technical_owner_id, a.created_by))
$$;

-- ---------------------------------------------------------------------------
-- Lifecycle guard: status and approval fields change only through workflow functions,
-- and only along allowed transitions.
-- ---------------------------------------------------------------------------
create function public.agents_lifecycle_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  allowed boolean := coalesce(current_setting('act.allow_lifecycle', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' and not allowed then
      raise exception 'New agents start as Proposed' using errcode = 'check_violation';
    end if;
    if not allowed then
      new.approved_by := null; new.approved_at := null;
      new.last_review_date := null; new.next_review_date := null;
    end if;
  elsif (new.status, new.approved_by, new.approved_at, new.last_review_date, new.next_review_date)
        is distinct from (old.status, old.approved_by, old.approved_at, old.last_review_date, old.next_review_date)
        and not allowed then
    raise exception 'Status and review fields change only through the approval workflow'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE' and new.status <> old.status and not (
       (old.status = 'proposed' and new.status = 'approved')
    or (old.status = 'approved' and new.status = 'live')
    or (old.status = 'live' and new.status = 'suspended')
    or (old.status = 'suspended' and new.status = 'live')
    or (old.status <> 'retired' and new.status = 'retired')) then
    raise exception 'An agent cannot move from % to %', old.status, new.status using errcode = 'check_violation';
  end if;

  -- §6.1: nothing reaches Approved or Live without a named business owner and a purpose.
  if new.status in ('approved', 'live')
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
     and (new.business_owner_id is null or length(trim(new.purpose_statement)) = 0) then
    raise exception 'A business owner and a purpose statement are required before an agent is approved or goes live'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger agents_lifecycle_guard before insert or update on public.agents
  for each row execute function public.agents_lifecycle_guard();

-- Agents under review or approved are frozen for ordinary edits; owners edit only while Proposed.
create function public.agents_edit_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('act.allow_lifecycle', true), '') = 'on' or public.has_role('admin') then
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

create trigger agents_edit_guard before update on public.agents
  for each row execute function public.agents_edit_guard();

-- Helper used by every workflow function.
create function public.begin_governed_change(p_reason text) returns void
language sql set search_path = '' as $$
  select set_config('act.allow_lifecycle', 'on', true), set_config('act.reason', coalesce(p_reason, ''), true);
$$;

create function public.end_governed_change() returns void
language sql set search_path = '' as $$
  select set_config('act.allow_lifecycle', '', true), set_config('act.reason', '', true);
$$;

-- ---------------------------------------------------------------------------
-- Registration workflow (§6.1, task 1.5)
-- ---------------------------------------------------------------------------
create function public.submit_agent_for_approval(p_agent_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  reg_id uuid;
begin
  select * into a from public.agents where id = p_agent_id for update;
  if not found then raise exception 'Agent not found' using errcode = 'no_data_found'; end if;

  if not (public.has_role('admin') or auth.uid() in (a.business_owner_id, a.technical_owner_id, a.created_by)
          or current_setting('act.actor_type', true) = 'integration') then
    raise exception 'Only the agent''s owners can submit it for approval' using errcode = 'insufficient_privilege';
  end if;
  if a.status <> 'proposed' then
    raise exception 'Only Proposed agents can be submitted (this one is %)', a.status using errcode = 'check_violation';
  end if;
  if a.business_owner_id is null then
    raise exception 'Name a business owner before submitting' using errcode = 'check_violation';
  end if;
  if length(trim(a.purpose_statement)) = 0 then
    raise exception 'Write a purpose statement before submitting' using errcode = 'check_violation';
  end if;
  if a.department_id is null then
    raise exception 'Choose a department before submitting, so the right approver gets it' using errcode = 'check_violation';
  end if;

  insert into public.agent_registrations (agent_id, submitted_by, required_approvals)
  values (a.id, auth.uid(), case when a.risk_tier = 'critical' then 2 else 1 end)
  returning id into reg_id;
  return reg_id;
exception when unique_violation then
  raise exception 'This agent is already waiting for approval' using errcode = 'check_violation';
end $$;

create function public.decide_registration(
  p_registration_id uuid, p_decision public.registration_decision, p_reason text default null
) returns public.registration_status
language plpgsql security definer set search_path = '' as $$
declare
  r public.agent_registrations;
  a public.agents;
  approvals int;
begin
  select * into r from public.agent_registrations where id = p_registration_id for update;
  if not found then raise exception 'Registration not found' using errcode = 'no_data_found'; end if;
  if r.status <> 'pending' then
    raise exception 'This registration was already decided (%)', r.status using errcode = 'check_violation';
  end if;
  select * into a from public.agents where id = r.agent_id for update;

  if not (public.has_role('admin') or public.in_approver_scope(a.department_id)) then
    raise exception 'You are not an approver for this agent''s department' using errcode = 'insufficient_privilege';
  end if;
  -- Segregation of duties: nobody approves their own agent.
  if auth.uid() in (a.business_owner_id, a.technical_owner_id, a.created_by, r.submitted_by) then
    raise exception 'You cannot decide on an agent you own or submitted' using errcode = 'insufficient_privilege';
  end if;
  if p_decision <> 'approve' and length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to reject or send back' using errcode = 'check_violation';
  end if;

  perform public.begin_governed_change(p_reason);

  insert into public.registration_decisions (registration_id, agent_id, approver_id, decision, reason)
  values (r.id, a.id, auth.uid(), p_decision, nullif(trim(coalesce(p_reason, '')), ''));

  if p_decision = 'approve' then
    select count(*) into approvals from public.registration_decisions
    where registration_id = r.id and decision = 'approve';
    if approvals >= r.required_approvals then
      update public.agent_registrations set status = 'approved', decided_at = now(), decision_reason = p_reason
      where id = r.id;
      update public.agents
      set status = 'approved', approved_by = auth.uid(), approved_at = now(),
          next_review_date = (current_date + interval '6 months')::date
      where id = a.id;
      r.status := 'approved';
    end if;
  else
    update public.agent_registrations
    set status = case when p_decision = 'reject' then 'rejected'::public.registration_status else 'sent_back' end,
        decided_at = now(), decision_reason = p_reason
    where id = r.id
    returning status into r.status;
  end if;

  perform public.end_governed_change();
  return r.status;
exception when unique_violation then
  raise exception 'You have already decided on this registration; a second approver is needed' using errcode = 'check_violation';
end $$;

create function public.go_live(p_agent_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.agents;
begin
  select * into a from public.agents where id = p_agent_id for update;
  if not found then raise exception 'Agent not found' using errcode = 'no_data_found'; end if;
  if not (public.has_role('admin') or auth.uid() in (a.business_owner_id, a.technical_owner_id)) then
    raise exception 'Only the agent''s owners can put it live' using errcode = 'insufficient_privilege';
  end if;
  if a.status <> 'approved' then
    raise exception 'Only Approved agents can go live (this one is %)', a.status using errcode = 'check_violation';
  end if;
  perform public.begin_governed_change(coalesce(p_reason, 'Put live by owner'));
  update public.agents set status = 'live' where id = a.id;
  perform public.end_governed_change();
end $$;

create function public.retire_agent(p_agent_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.agents;
begin
  select * into a from public.agents where id = p_agent_id for update;
  if not found then raise exception 'Agent not found' using errcode = 'no_data_found'; end if;
  if not (public.has_role('admin') or auth.uid() = a.business_owner_id) then
    raise exception 'Only the business owner or an admin can retire an agent' using errcode = 'insufficient_privilege';
  end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to retire an agent' using errcode = 'check_violation';
  end if;
  perform public.begin_governed_change(p_reason);
  update public.agents set status = 'retired' where id = a.id;
  update public.alerts set resolved_at = now() where agent_id = a.id and resolved_at is null;
  perform public.end_governed_change();
end $$;

-- ---------------------------------------------------------------------------
-- Reviews and alerts (task 1.6)
-- ---------------------------------------------------------------------------
create function public.record_review(
  p_agent_id uuid, p_outcome public.review_outcome, p_notes text default null
) returns date
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  next_date date := (current_date + interval '6 months')::date;
begin
  select * into a from public.agents where id = p_agent_id for update;
  if not found then raise exception 'Agent not found' using errcode = 'no_data_found'; end if;
  if not (public.has_role('admin') or auth.uid() = a.business_owner_id or public.in_approver_scope(a.department_id)) then
    raise exception 'Only the business owner or an approver for this department can review this agent'
      using errcode = 'insufficient_privilege';
  end if;
  if a.status not in ('approved', 'live', 'suspended') then
    raise exception 'Only approved, live or suspended agents are reviewed' using errcode = 'check_violation';
  end if;
  if p_outcome <> 'no_change' and length(trim(coalesce(p_notes, ''))) = 0 then
    raise exception 'Notes are required when the review finds changes or retires the agent' using errcode = 'check_violation';
  end if;

  perform public.begin_governed_change(p_notes);
  insert into public.agent_reviews (agent_id, reviewer_id, outcome, notes, next_review_date)
  values (a.id, auth.uid(), p_outcome, p_notes, case when p_outcome = 'retire' then null else next_date end);

  if p_outcome = 'retire' then
    update public.agents set status = 'retired', last_review_date = current_date, next_review_date = null where id = a.id;
    next_date := null;
  else
    update public.agents set last_review_date = current_date, next_review_date = next_date where id = a.id;
  end if;
  update public.alerts set resolved_at = now()
  where agent_id = a.id and kind = 'review_overdue' and resolved_at is null;
  perform public.end_governed_change();
  return next_date;
end $$;

-- Raises and clears alerts. Run daily by pg_cron; admins can also run it on demand.
create function public.refresh_alerts() returns integer
language plpgsql security definer set search_path = '' as $$
declare raised integer;
begin
  if auth.uid() is not null and not public.has_role('admin') then
    raise exception 'Only admins can refresh alerts' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('act.actor_type', 'system', true);

  update public.alerts al set resolved_at = now()
  from public.agents a
  where al.agent_id = a.id and al.resolved_at is null
    and ((al.kind = 'review_overdue' and (a.status <> 'live' or a.next_review_date >= current_date))
      or (al.kind = 'owner_missing' and (a.business_owner_id is not null or a.status in ('proposed', 'retired'))));

  with new_alerts as (
    insert into public.alerts (kind, agent_id, message)
    select 'review_overdue'::public.alert_kind, a.id,
           format('%s review was due on %s', a.agent_code, to_char(a.next_review_date, 'DD Mon YYYY'))
    from public.agents a
    where a.status = 'live' and a.next_review_date < current_date
    union all
    select 'owner_missing'::public.alert_kind, a.id, format('%s has no business owner', a.agent_code)
    from public.agents a
    where a.status in ('approved', 'live', 'suspended') and a.business_owner_id is null
    on conflict do nothing
    returning 1)
  select count(*) into raised from new_alerts;

  perform set_config('act.actor_type', '', true);
  return raised;
end $$;

-- Daily at 01:15 UTC where pg_cron exists (Supabase); skipped in test databases.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('act-refresh-alerts', '15 1 * * *', 'select public.refresh_alerts()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- API keys (task 1.7)
-- ---------------------------------------------------------------------------
create function public.new_secret(p_prefix text) returns text
language sql volatile set search_path = '' as $$
  select p_prefix || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;

create function public.secret_hash(p_secret text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
$$;

create function public.create_integration_key(p_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare k text := public.new_secret('act_int_');
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can create integration keys' using errcode = 'insufficient_privilege';
  end if;
  insert into public.integration_keys (name, key_prefix, key_hash, created_by)
  values (p_name, left(k, 16), public.secret_hash(k), auth.uid());
  return k;
end $$;

create function public.create_agent_api_key(p_agent_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare k text := public.new_secret('act_agt_');
begin
  if not (public.has_role('admin') or public.is_agent_owner(p_agent_id)) then
    raise exception 'Only the agent''s owners can create its API key' using errcode = 'insufficient_privilege';
  end if;
  insert into public.agent_api_keys (agent_id, key_prefix, key_hash, created_by)
  values (p_agent_id, left(k, 16), public.secret_hash(k), auth.uid());
  return k;
end $$;

create function public.revoke_api_key(p_key_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.agent_api_keys set revoked_at = now()
  where id = p_key_id and revoked_at is null
    and (public.has_role('admin') or public.is_agent_owner(agent_id));
  if not found then
    update public.integration_keys set revoked_at = now()
    where id = p_key_id and revoked_at is null and public.has_role('admin');
  end if;
  if not found then
    raise exception 'Key not found, already revoked, or not yours to revoke' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- POST /api/v1/agents/register. Called by the Edge Function with the integration key from the request.
create function public.api_register_agent(p_integration_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ik public.integration_keys;
  dept uuid;
  bo uuid;
  tech uuid;
  new_agent public.agents;
  agent_key text;
  reg_id uuid;
  submit boolean := coalesce((p_payload ->> 'submit')::boolean, true);
begin
  select * into ik from public.integration_keys
  where key_hash = public.secret_hash(coalesce(p_integration_key, '')) and revoked_at is null;
  if not found then raise exception 'Invalid or revoked integration key' using errcode = 'invalid_authorization_specification'; end if;
  update public.integration_keys set last_used_at = now() where id = ik.id;

  perform set_config('act.actor_type', 'integration', true);
  perform set_config('act.actor_id', ik.id::text, true);

  if length(trim(coalesce(p_payload ->> 'name', ''))) = 0 then
    raise exception 'name is required' using errcode = 'check_violation';
  end if;
  if p_payload ? 'department' then
    select id into dept from public.departments where lower(name) = lower(p_payload ->> 'department');
    if dept is null then raise exception 'Unknown department: %', p_payload ->> 'department' using errcode = 'check_violation'; end if;
  end if;
  if p_payload ? 'business_owner_email' then
    select id into bo from public.profiles where lower(email) = lower(p_payload ->> 'business_owner_email');
    if bo is null then raise exception 'No user with email %', p_payload ->> 'business_owner_email' using errcode = 'check_violation'; end if;
  end if;
  if p_payload ? 'technical_owner_email' then
    select id into tech from public.profiles where lower(email) = lower(p_payload ->> 'technical_owner_email');
    if tech is null then raise exception 'No user with email %', p_payload ->> 'technical_owner_email' using errcode = 'check_violation'; end if;
  end if;

  insert into public.agents (
    name, description, version, origin, vendor_name, framework,
    business_owner_id, technical_owner_id, department_id, cost_centre,
    purpose_statement, in_scope_actions, out_of_scope_actions,
    systems_accessed, data_classifications, credential_type, credential_owner,
    autonomy_level, value_threshold, threshold_currency, volume_threshold,
    risk_tier, regulatory_flags, registration_source, control_endpoint, created_by)
  values (
    p_payload ->> 'name', p_payload ->> 'description', p_payload ->> 'version',
    coalesce((p_payload ->> 'origin')::public.agent_origin, 'internal'), p_payload ->> 'vendor_name',
    coalesce((p_payload ->> 'framework')::public.agent_framework, 'other'),
    bo, tech, dept, p_payload ->> 'cost_centre',
    coalesce(p_payload ->> 'purpose_statement', ''),
    coalesce(array(select jsonb_array_elements_text(p_payload -> 'in_scope_actions')), '{}'),
    coalesce(array(select jsonb_array_elements_text(p_payload -> 'out_of_scope_actions')), '{}'),
    coalesce(array(select jsonb_array_elements_text(p_payload -> 'systems_accessed')), '{}'),
    coalesce(array(select jsonb_array_elements_text(p_payload -> 'data_classifications')::public.data_classification), '{}'),
    p_payload ->> 'credential_type', p_payload ->> 'credential_owner',
    coalesce((p_payload ->> 'autonomy_level')::smallint, 1),
    (p_payload ->> 'value_threshold')::numeric, coalesce(p_payload ->> 'threshold_currency', 'GBP'),
    (p_payload ->> 'volume_threshold')::integer,
    coalesce((p_payload ->> 'risk_tier')::public.risk_tier, 'medium'),
    coalesce(array(select jsonb_array_elements_text(p_payload -> 'regulatory_flags')), '{}'),
    'api', p_payload ->> 'control_endpoint', null)
  returning * into new_agent;

  agent_key := public.new_secret('act_agt_');
  insert into public.agent_api_keys (agent_id, key_prefix, key_hash)
  values (new_agent.id, left(agent_key, 16), public.secret_hash(agent_key));

  -- Submit straight away when the registration is complete; otherwise it waits as Proposed.
  if submit and bo is not null and dept is not null and length(trim(new_agent.purpose_statement)) > 0 then
    reg_id := public.submit_agent_for_approval(new_agent.id);
  end if;

  perform set_config('act.actor_type', '', true);
  perform set_config('act.actor_id', '', true);

  return jsonb_build_object(
    'agent_id', new_agent.id,
    'agent_code', new_agent.agent_code,
    'status', new_agent.status,
    'submitted_for_approval', reg_id is not null,
    'registration_id', reg_id,
    'api_key', agent_key,
    'note', case when reg_id is null
                 then 'Saved as Proposed. Add a business owner, department and purpose statement, then submit for approval.'
                 else 'Submitted for approval. The agent may not act until it is approved and put live.' end);
exception
  when invalid_text_representation or invalid_parameter_value or numeric_value_out_of_range then
    raise exception 'A field has an invalid value: %', sqlerrm using errcode = 'check_violation';
end $$;

-- GET /api/v1/agents/{id}/status. Agents call this to learn whether they may act.
create function public.api_agent_status(p_agent_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k public.agent_api_keys;
  a public.agents;
begin
  select * into k from public.agent_api_keys
  where key_hash = public.secret_hash(coalesce(p_agent_key, '')) and revoked_at is null;
  if not found then raise exception 'Invalid or revoked agent key' using errcode = 'invalid_authorization_specification'; end if;
  select * into a from public.agents where id = k.agent_id;
  -- Not audited: status checks are frequent reads. last_used_at is enough evidence of contact.
  update public.agent_api_keys set last_used_at = now() where id = k.id;
  return jsonb_build_object('agent_id', a.id, 'agent_code', a.agent_code, 'status', a.status,
                            'may_act', a.status = 'live', 'autonomy_level', a.autonomy_level);
end $$;

-- Key usage (last_used_at) is not worth an audit row per call; creation, revocation and deletion are.
drop trigger audit_change on public.agent_api_keys;
create trigger audit_change after insert or delete on public.agent_api_keys
  for each row execute function public.audit_table_change();
create trigger audit_change_revoke after update of revoked_at on public.agent_api_keys
  for each row execute function public.audit_table_change();
drop trigger audit_change on public.integration_keys;
create trigger audit_change after insert or delete on public.integration_keys
  for each row execute function public.audit_table_change();
create trigger audit_change_revoke after update of revoked_at on public.integration_keys
  for each row execute function public.audit_table_change();

-- ---------------------------------------------------------------------------
-- Row-level security (task 1.3)
-- ---------------------------------------------------------------------------
alter table public.departments enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.approver_scopes enable row level security;
alter table public.agents enable row level security;
alter table public.agent_registrations enable row level security;
alter table public.registration_decisions enable row level security;
alter table public.agent_reviews enable row level security;
alter table public.alerts enable row level security;
alter table public.integration_keys enable row level security;
alter table public.agent_api_keys enable row level security;
alter table public.audit_events enable row level security;

create policy "departments readable" on public.departments for select to authenticated using (true);
create policy "departments admin" on public.departments for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy "profiles readable" on public.profiles for select to authenticated using (true);
create policy "profiles self or admin update" on public.profiles for update to authenticated
  using (id = auth.uid() or public.has_role('admin')) with check (id = auth.uid() or public.has_role('admin'));

create policy "roles readable" on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.sees_everything());
create policy "roles admin" on public.user_roles for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy "scopes readable" on public.approver_scopes for select to authenticated
  using (user_id = auth.uid() or public.sees_everything());
create policy "scopes admin" on public.approver_scopes for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy "agents visible in scope" on public.agents for select to authenticated
  using (public.sees_everything()
         or auth.uid() in (business_owner_id, technical_owner_id, created_by)
         or public.in_approver_scope(department_id));
create policy "owners and admins propose agents" on public.agents for insert to authenticated
  with check ((public.has_role('owner') or public.has_role('admin')) and created_by = auth.uid());
create policy "owners edit own proposals, admins edit all" on public.agents for update to authenticated
  using (public.has_role('admin') or auth.uid() in (business_owner_id, technical_owner_id, created_by))
  with check (public.has_role('admin') or auth.uid() in (business_owner_id, technical_owner_id, created_by));

create policy "registrations visible with agent" on public.agent_registrations for select to authenticated
  using (public.can_see_agent(agent_id));
create policy "decisions visible with agent" on public.registration_decisions for select to authenticated
  using (public.can_see_agent(agent_id));
create policy "reviews visible with agent" on public.agent_reviews for select to authenticated
  using (public.can_see_agent(agent_id));
create policy "alerts visible with agent" on public.alerts for select to authenticated
  using (public.can_see_agent(agent_id));

create policy "integration keys admin" on public.integration_keys for select to authenticated
  using (public.has_role('admin'));
create policy "agent keys owners" on public.agent_api_keys for select to authenticated
  using (public.has_role('admin') or public.is_agent_owner(agent_id));

create policy "audit visible" on public.audit_events for select to authenticated
  using (public.sees_everything() or (agent_id is not null and public.can_see_agent(agent_id)));

-- ---------------------------------------------------------------------------
-- Grants. New Supabase projects grant nothing by default; RLS then narrows rows.
-- ---------------------------------------------------------------------------
grant select on public.departments, public.profiles, public.user_roles, public.approver_scopes,
  public.agents, public.agent_registrations, public.registration_decisions, public.agent_reviews,
  public.alerts, public.audit_events to authenticated;
grant insert, update, delete on public.departments, public.user_roles, public.approver_scopes to authenticated;
grant update (full_name, job_title, department_id, is_active) on public.profiles to authenticated;
grant insert (name, description, version, origin, vendor_name, framework, business_owner_id, technical_owner_id,
  department_id, cost_centre, purpose_statement, in_scope_actions, out_of_scope_actions, systems_accessed,
  data_classifications, credential_type, credential_owner, autonomy_level, value_threshold, threshold_currency,
  volume_threshold, risk_tier, regulatory_flags, control_endpoint, created_by) on public.agents to authenticated;
grant update (name, description, version, origin, vendor_name, framework, business_owner_id, technical_owner_id,
  department_id, cost_centre, purpose_statement, in_scope_actions, out_of_scope_actions, systems_accessed,
  data_classifications, credential_type, credential_owner, autonomy_level, value_threshold, threshold_currency,
  volume_threshold, risk_tier, regulatory_flags, control_endpoint) on public.agents to authenticated;
grant usage on sequence public.agent_code_seq to authenticated;
-- Key tables: never expose the hash column.
grant select (id, name, key_prefix, created_by, created_at, revoked_at, last_used_at) on public.integration_keys to authenticated;
grant select (id, agent_id, key_prefix, created_by, created_at, revoked_at, last_used_at) on public.agent_api_keys to authenticated;

-- Functions: nobody by default, then exactly who needs each one.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.has_role(public.app_role), public.sees_everything(), public.in_approver_scope(uuid),
  public.can_see_agent(uuid), public.is_agent_owner(uuid),
  public.submit_agent_for_approval(uuid), public.decide_registration(uuid, public.registration_decision, text),
  public.go_live(uuid, text), public.retire_agent(uuid, text),
  public.record_review(uuid, public.review_outcome, text), public.refresh_alerts(),
  public.create_integration_key(text), public.create_agent_api_key(uuid), public.revoke_api_key(uuid),
  public.audit_verify_chain()
  to authenticated;
-- The API functions are called only by the Edge Function, which holds the secret key.
grant execute on function public.api_register_agent(text, jsonb), public.api_agent_status(text) to service_role;
