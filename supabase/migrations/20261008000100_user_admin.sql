-- User administration: admins add people, set their roles and approval departments, reset passwords
-- and deactivate accounts, all from the Users screen. No email needed: a new or reset account gets a
-- one-time temporary password that the admin passes on, and the person must choose their own on first sign-in.
-- (Email invites can replace the temporary password once outgoing email is set up.)

alter table public.profiles add column must_change_password boolean not null default false;

-- ---------------------------------------------------------------------------
-- A deactivated person holds no role, so row-level security shows them nothing even if a session
-- is still open. Same signatures as before, so existing grants and policies keep working.
-- ---------------------------------------------------------------------------
create or replace function public.has_role(p_role public.app_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                 where r.user_id = auth.uid() and r.role = p_role and p.is_active)
$$;

create or replace function public.sees_everything() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                 where r.user_id = auth.uid() and r.role in ('admin', 'executive', 'auditor') and p.is_active)
$$;

-- Owners keep seeing their agents through ownership, so ownership checks need the same rule.
create or replace function public.can_see_agent(p_agent_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.agents a
    where a.id = p_agent_id
      and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active)
      and (public.sees_everything()
           or auth.uid() in (a.business_owner_id, a.technical_owner_id, a.created_by)
           or public.in_approver_scope(a.department_id)))
$$;

create or replace function public.is_agent_owner(p_agent_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.agents a
                 where a.id = p_agent_id and auth.uid() in (a.business_owner_id, a.technical_owner_id, a.created_by)
                   and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active))
$$;

create function public.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and is_active)
$$;

-- The agents policies check ownership inline; add the active-user condition to them.
alter policy "agents visible in scope" on public.agents
  using (public.is_active_user() and (public.sees_everything()
         or auth.uid() in (business_owner_id, technical_owner_id, created_by)
         or public.in_approver_scope(department_id)));
alter policy "owners edit own proposals, admins edit all" on public.agents
  using (public.has_role('admin') or (public.is_active_user() and auth.uid() in (business_owner_id, technical_owner_id, created_by)))
  with check (public.has_role('admin') or (public.is_active_user() and auth.uid() in (business_owner_id, technical_owner_id, created_by)));

-- People may edit their own name and job title; everything else goes through the admin functions below.
revoke update on public.profiles from authenticated;
grant update (full_name, job_title) on public.profiles to authenticated;
alter policy "profiles self or admin update" on public.profiles
  using (id = auth.uid() and public.is_active_user()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- Guard rails on roles, whichever way they are changed.
-- ---------------------------------------------------------------------------
create function public.user_roles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin' or new.user_id <> old.user_id) then
    if old.user_id = auth.uid() then
      raise exception 'You cannot remove your own Admin role. Ask another admin.' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                   where r.role = 'admin' and p.is_active and r.user_id <> old.user_id) then
      raise exception 'At least one active admin must remain.' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end $$;

create trigger user_roles_guard before update or delete on public.user_roles
  for each row execute function public.user_roles_guard();

-- ---------------------------------------------------------------------------
-- Admin functions
-- ---------------------------------------------------------------------------
create function public.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can manage users' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- Readable temporary password, e.g. 7f3a-91c2-0be4-d58e (64 bits of randomness, used once).
create function public.temporary_password() returns text
language sql volatile set search_path = '' as $$
  select regexp_replace(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), '(.{4})(?!$)', '\1-', 'g')
$$;

-- Everyone, with roles, approval departments and last sign-in (which lives in Supabase's auth schema).
create function public.admin_list_users()
returns table (id uuid, full_name text, email text, job_title text, department_id uuid, is_active boolean,
               must_change_password boolean, roles public.app_role[], scope_department_ids uuid[],
               last_sign_in_at timestamptz, created_at timestamptz, owned_agents integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return query
  select p.id, p.full_name, p.email, p.job_title, p.department_id, p.is_active, p.must_change_password,
         coalesce((select array_agg(r.role order by r.role) from public.user_roles r where r.user_id = p.id), '{}'),
         coalesce((select array_agg(s.department_id) from public.approver_scopes s where s.user_id = p.id), '{}'),
         u.last_sign_in_at, p.created_at,
         (select count(*)::int from public.agents a
          where a.status <> 'retired' and p.id in (a.business_owner_id, a.technical_owner_id))
  from public.profiles p join auth.users u on u.id = p.id
  order by p.is_active desc, p.full_name;
end $$;

-- Replaces a person's roles and approval departments with exactly the ones given.
create function public.set_user_access(p_user_id uuid, p_roles public.app_role[], p_scope_department_ids uuid[])
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_roles public.app_role[] := coalesce(p_roles, '{}');
  v_scopes uuid[] := case when 'approver' = any(coalesce(p_roles, '{}')) then coalesce(p_scope_department_ids, '{}') else '{}' end;
begin
  if 'approver' = any(v_roles) and cardinality(v_scopes) = 0 then
    raise exception 'Choose at least one department this approver approves for.' using errcode = 'check_violation';
  end if;
  delete from public.user_roles where user_id = p_user_id and role <> all(v_roles);
  insert into public.user_roles (user_id, role) select p_user_id, r from unnest(v_roles) r on conflict do nothing;
  delete from public.approver_scopes where user_id = p_user_id and department_id <> all(v_scopes);
  insert into public.approver_scopes (user_id, department_id) select p_user_id, d from unnest(v_scopes) d on conflict do nothing;
end $$;

create function public.admin_create_user(
  p_email text, p_full_name text, p_job_title text, p_department_id uuid,
  p_roles public.app_role[], p_scope_department_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_name text := trim(p_full_name);
  v_id uuid := gen_random_uuid();
  v_password text := public.temporary_password();
begin
  perform public.require_admin();
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address.' using errcode = 'check_violation';
  end if;
  if coalesce(v_name, '') = '' then
    raise exception 'Enter the person''s name.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'Someone with this email already has an account.' using errcode = 'unique_violation';
  end if;
  perform set_config('act.reason', 'User added by admin', true);

  -- The same shape Supabase Auth itself writes for an email-and-password user with a confirmed email.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token)
  values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', v_name), now(), now(),
    '', '', '', '');
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (v_id::text, v_id, jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
          'email', now(), now());

  -- The auth trigger created the profile; fill in the rest.
  update public.profiles
     set full_name = v_name, job_title = nullif(trim(p_job_title), ''), department_id = p_department_id,
         must_change_password = true
   where id = v_id;
  perform public.set_user_access(v_id, p_roles, p_scope_department_ids);
  perform set_config('act.reason', '', true);
  return jsonb_build_object('id', v_id, 'temporary_password', v_password);
end $$;

create function public.admin_update_user(
  p_user_id uuid, p_full_name text, p_job_title text, p_department_id uuid,
  p_roles public.app_role[], p_scope_department_ids uuid[])
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  if coalesce(trim(p_full_name), '') = '' then
    raise exception 'Enter the person''s name.' using errcode = 'check_violation';
  end if;
  update public.profiles
     set full_name = trim(p_full_name), job_title = nullif(trim(p_job_title), ''), department_id = p_department_id
   where id = p_user_id;
  if not found then
    raise exception 'User not found' using errcode = 'no_data_found';
  end if;
  perform public.set_user_access(p_user_id, p_roles, p_scope_department_ids);
end $$;

create function public.admin_reset_password(p_user_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_password text := public.temporary_password();
begin
  perform public.require_admin();
  update auth.users set encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')), updated_at = now()
   where id = p_user_id;
  if not found then
    raise exception 'User not found' using errcode = 'no_data_found';
  end if;
  perform set_config('act.reason', 'Password reset by admin', true);
  update public.profiles set must_change_password = true where id = p_user_id;
  perform set_config('act.reason', '', true);
  return v_password;
end $$;

-- Deactivating blocks sign-in, ends open sessions, and raises "no owner" alerts on the agents they owned.
-- History is kept: nothing about the person is deleted.
create function public.admin_set_user_active(p_user_id uuid, p_active boolean, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  if p_user_id = auth.uid() and not p_active then
    raise exception 'You cannot deactivate your own account.' using errcode = 'check_violation';
  end if;
  if not p_active and coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason, for example "Left the bank".' using errcode = 'check_violation';
  end if;
  if not p_active and exists (select 1 from public.user_roles where user_id = p_user_id and role = 'admin')
     and not exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                     where r.role = 'admin' and p.is_active and r.user_id <> p_user_id) then
    raise exception 'At least one active admin must remain.' using errcode = 'check_violation';
  end if;

  perform set_config('act.reason', coalesce(nullif(trim(p_reason), ''), case when p_active then 'Reactivated' else 'Deactivated' end), true);
  update public.profiles set is_active = p_active where id = p_user_id;
  if not found then
    raise exception 'User not found' using errcode = 'no_data_found';
  end if;
  perform set_config('act.reason', '', true);

  update auth.users set banned_until = case when p_active then null else now() + interval '100 years' end, updated_at = now()
   where id = p_user_id;
  if not p_active and to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where user_id = $1' using p_user_id;
  end if;
  perform public.refresh_alerts();
end $$;

-- Called by the app after the person has set their own password.
create function public.password_changed() returns void
language sql security definer set search_path = '' as $$
  update public.profiles set must_change_password = false where id = auth.uid() and must_change_password
$$;

-- ---------------------------------------------------------------------------
-- An agent whose business owner has been deactivated counts as having no owner.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_alerts() returns integer
language plpgsql security definer set search_path = '' as $$
declare raised integer;
begin
  if auth.uid() is not null and not public.has_role('admin') then
    raise exception 'Only admins can refresh alerts' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('act.actor_type', 'system', true);

  update public.alerts al set resolved_at = now()
  from public.agents a
  left join public.profiles o on o.id = a.business_owner_id
  where al.agent_id = a.id and al.resolved_at is null
    and ((al.kind = 'review_overdue' and (a.status <> 'live' or a.next_review_date >= current_date))
      or (al.kind = 'owner_missing' and ((a.business_owner_id is not null and o.is_active) or a.status in ('proposed', 'retired'))));

  with new_alerts as (
    insert into public.alerts (kind, agent_id, message)
    select 'review_overdue'::public.alert_kind, a.id,
           format('%s review was due on %s', a.agent_code, to_char(a.next_review_date, 'DD Mon YYYY'))
    from public.agents a
    where a.status = 'live' and a.next_review_date < current_date
    union all
    select 'owner_missing'::public.alert_kind, a.id,
           case when a.business_owner_id is null then format('%s has no business owner', a.agent_code)
                else format('%s''s business owner %s has been deactivated', a.agent_code, o.full_name) end
    from public.agents a
    left join public.profiles o on o.id = a.business_owner_id
    where a.status in ('approved', 'live', 'suspended') and (a.business_owner_id is null or not o.is_active)
    on conflict do nothing
    returning 1)
  select count(*) into raised from new_alerts;

  perform set_config('act.actor_type', '', true);
  return raised;
end $$;

-- ---------------------------------------------------------------------------
-- Grants: nobody by default, then exactly who needs each one.
-- ---------------------------------------------------------------------------
revoke execute on function
  public.is_active_user(), public.user_roles_guard(), public.require_admin(), public.temporary_password(),
  public.admin_list_users(), public.set_user_access(uuid, public.app_role[], uuid[]),
  public.admin_create_user(text, text, text, uuid, public.app_role[], uuid[]),
  public.admin_update_user(uuid, text, text, uuid, public.app_role[], uuid[]),
  public.admin_reset_password(uuid), public.admin_set_user_active(uuid, boolean, text), public.password_changed()
  from public, anon, authenticated;
grant execute on function
  public.is_active_user(), public.admin_list_users(),
  public.admin_create_user(text, text, text, uuid, public.app_role[], uuid[]),
  public.admin_update_user(uuid, text, text, uuid, public.app_role[], uuid[]),
  public.admin_reset_password(uuid), public.admin_set_user_active(uuid, boolean, text), public.password_changed()
  to authenticated;
