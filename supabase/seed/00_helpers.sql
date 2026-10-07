-- Shared helpers for the demo seed files. psql runs all seed files in one session
-- (psql -f 00_helpers.sql -f 02_demo_bank.sql -f 03_more_agents.sql), so these pg_temp functions
-- are visible to every file and vanish when the session ends.

-- Helpers live in pg_temp and disappear at the end of the session.
create or replace function pg_temp.uid(p_email text) returns uuid language sql stable as $$
  select id from public.profiles where email = p_email
$$;

-- Act as a persona for the rest of the current transaction (as PostgREST would after login).
create or replace function pg_temp.act_as(p_email text) returns void language plpgsql as $$
declare v uuid := pg_temp.uid(p_email);
begin
  if v is null then raise exception 'Seed persona % not found; run 01_users.sql first', p_email; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.act_as_system() returns void language sql as $$
  select set_config('request.jwt.claims', '', true);
$$;

create or replace function pg_temp.dept(p_name text) returns uuid language sql stable as $$
  select id from public.departments where name = p_name
$$;

create or replace function pg_temp.agent(p_name text) returns uuid language sql stable as $$
  select id from public.agents where name = p_name
$$;

-- Submit as owner, approve by each approver in turn, optionally put live.
create or replace function pg_temp.approve(p_agent text, p_owner text, p_approvers text[], p_live boolean) returns void
language plpgsql as $$
declare
  reg uuid;
  a text;
begin
  perform pg_temp.act_as(p_owner);
  reg := public.submit_agent_for_approval(pg_temp.agent(p_agent));
  foreach a in array p_approvers loop
    perform pg_temp.act_as(a);
    perform public.decide_registration(reg, 'approve', null);
  end loop;
  if p_live then
    perform pg_temp.act_as(p_owner);
    perform public.go_live(pg_temp.agent(p_agent), null);
  end if;
end $$;

-- Move an agent's dates back in time (bypasses the workflow, so the guard flag is set explicitly).
create or replace function pg_temp.backdate(p_agent text, p_created_days int, p_approved_days int, p_next_review date) returns void
language plpgsql as $$
begin
  perform pg_temp.act_as_system();
  perform set_config('act.allow_lifecycle', 'on', true);
  perform set_config('act.actor_type', 'system', true);
  perform set_config('act.reason', 'Demo data: historical dates', true);
  update public.agents
  set created_at = now() - make_interval(days => p_created_days),
      approved_at = case when approved_at is null then null else now() - make_interval(days => p_approved_days) end,
      last_review_date = case when approved_at is null then null else (current_date - p_approved_days) end,
      next_review_date = case when approved_at is null then null else p_next_review end
  where id = pg_temp.agent(p_agent);
  update public.agent_registrations set submitted_at = now() - make_interval(days => p_approved_days + 3),
    decided_at = case when decided_at is null then null else now() - make_interval(days => p_approved_days) end
  where agent_id = pg_temp.agent(p_agent) and status <> 'pending';
  perform set_config('act.allow_lifecycle', '', true);
  perform set_config('act.actor_type', '', true);
  perform set_config('act.reason', '', true);
end $$;

-- A past review recorded by a persona, dated days_ago. Inserted directly so the date can be historic.
create or replace function pg_temp.past_review(p_agent text, p_reviewer text, p_days_ago int,
  p_outcome public.review_outcome, p_notes text) returns void
language plpgsql as $$
begin
  perform pg_temp.act_as(p_reviewer);
  insert into public.agent_reviews (agent_id, reviewer_id, reviewed_at, outcome, notes, next_review_date)
  values (pg_temp.agent(p_agent), pg_temp.uid(p_reviewer), now() - make_interval(days => p_days_ago), p_outcome, p_notes,
          (current_date - p_days_ago + interval '6 months')::date);
end $$;

-- Registers one agent as its business owner (so the audit trail names them). Returns nothing.
create or replace function pg_temp.new_agent(
  p_owner text, p_tech text, p_dept text, p_name text, p_description text, p_framework public.agent_framework,
  p_purpose text, p_in text[], p_out text[], p_systems text[], p_data public.data_classification[],
  p_cred_type text, p_cred_owner text, p_level smallint, p_value numeric, p_volume integer,
  p_risk public.risk_tier, p_flags text[], p_version text,
  p_origin public.agent_origin default 'internal', p_vendor text default null) returns void
language plpgsql as $$
begin
  perform pg_temp.act_as(p_owner);
  insert into public.agents (name, description, origin, vendor_name, framework, business_owner_id, technical_owner_id,
    department_id, purpose_statement, in_scope_actions, out_of_scope_actions, systems_accessed, data_classifications,
    credential_type, credential_owner, autonomy_level, value_threshold, volume_threshold, risk_tier, regulatory_flags,
    version, created_by)
  values (p_name, p_description, p_origin, p_vendor, p_framework, pg_temp.uid(p_owner), pg_temp.uid(p_tech),
    pg_temp.dept(p_dept), p_purpose, p_in, p_out, p_systems, p_data, p_cred_type, p_cred_owner, p_level, p_value,
    p_volume, p_risk, p_flags, p_version, pg_temp.uid(p_owner));
end $$;
