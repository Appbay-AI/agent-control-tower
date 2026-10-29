-- Task 3.2: connections to agent platforms (the Appian simulator now; Microsoft Copilot Studio later).
--
-- A connection says which kind of platform it is (which plug-in the API uses, functions-lib/platforms) and where it
-- is. Its secret (for Appian, the API key) is kept in platform_secrets, which nobody can read: it comes straight from
-- the GitHub secret APPIAN_API_KEY through the Database migrations workflow (scripts/platform-setup.mjs), the same way
-- the email key is kept (task 2.7). Switching platform is a change of data here, not of code.
--
-- Work on a platform is done by our Cloudflare API, never by the browser, so the secret never reaches a browser:
--   1. An admin presses "Test connection": platform_job_start adds a job with a one-time token and asks our site to
--      run it (pg_net posts the token to <site>/api/v1/platforms/run after the transaction commits).
--   2. The API trades the token for the job and the connection, secret included (platform_job_claim), runs the plug-in
--      and reports what happened (platform_job_report). Each token works once and for ten minutes.
--   3. The page shows the result.
-- The scheduled fetch (task 3.3) adds a 'sync' kind of job on the same path.

create table public.platform_connections (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('appian_simulator')),
  name text not null unique check (length(btrim(name)) between 1 and 120),
  base_url text not null check (base_url ~ '^https://[a-z0-9.-]+\.[a-z]{2,}$'),
  secret_set_at timestamptz,         -- when the secret was last stored (the secret itself is in platform_secrets)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.platform_connections enable row level security;
create policy "admins see platform connections" on public.platform_connections for select to authenticated
  using (public.has_role('admin'));
revoke all on public.platform_connections from anon, authenticated;
grant select on public.platform_connections to authenticated;

create trigger audit_change after insert or update or delete on public.platform_connections
  for each row execute function public.audit_table_change();

create table public.platform_secrets (
  connection_id uuid primary key references public.platform_connections (id) on delete cascade,
  secret text not null check (length(secret) between 1 and 4000),
  updated_at timestamptz not null default now()
);
-- No policies and no grants: only the functions below can read it.
alter table public.platform_secrets enable row level security;
revoke all on public.platform_secrets from anon, authenticated;

create table public.platform_jobs (
  id bigint generated always as identity primary key,
  connection_id uuid not null references public.platform_connections (id) on delete cascade,
  kind text not null check (kind in ('check')),
  requested_by uuid references public.profiles (id) on delete set null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  ok boolean,
  message text check (length(message) <= 1000),
  result jsonb check (pg_column_size(result) <= 65536)
);
create index platform_jobs_latest on public.platform_jobs (connection_id, id desc);
alter table public.platform_jobs enable row level security;
create policy "admins see platform jobs" on public.platform_jobs for select to authenticated
  using (public.has_role('admin'));
revoke all on public.platform_jobs from anon, authenticated;
-- Everything except the token's hash.
grant select (id, connection_id, kind, requested_by, created_at, claimed_at, finished_at, ok, message, result)
  on public.platform_jobs to authenticated;

-- ---------------------------------------------------------------------------
-- Setting up a connection (run by the Database migrations workflow as the database owner; nobody else may)
-- ---------------------------------------------------------------------------
create function public.platform_configure(p_kind text, p_name text, p_base_url text, p_secret text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  c public.platform_connections;
  url text := lower(regexp_replace(btrim(coalesce(p_base_url, '')), '/+$', ''));
  outcome text;
begin
  select * into c from public.platform_connections where name = btrim(p_name);
  if not found then
    insert into public.platform_connections (kind, name, base_url) values (p_kind, btrim(p_name), url) returning * into c;
    outcome := 'created';
  elsif c.kind is distinct from p_kind or c.base_url is distinct from url then
    update public.platform_connections set kind = p_kind, base_url = url, updated_at = now() where id = c.id;
    outcome := 'updated';
  else
    outcome := 'unchanged';
  end if;
  if coalesce(p_secret, '') <> '' and not exists (
       select 1 from public.platform_secrets where connection_id = c.id and secret = p_secret) then
    insert into public.platform_secrets (connection_id, secret) values (c.id, p_secret)
      on conflict (connection_id) do update set secret = excluded.secret, updated_at = now();
    update public.platform_connections set secret_set_at = now(), updated_at = now() where id = c.id;
    outcome := outcome || ', secret stored';
  elsif not exists (select 1 from public.platform_secrets where connection_id = c.id) then
    outcome := outcome || ', no secret';
  end if;
  return outcome;
end $$;

-- ---------------------------------------------------------------------------
-- Starting a job (admins, from the app)
-- ---------------------------------------------------------------------------
create function public.platform_job_start(p_connection uuid, p_kind text default 'check') returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  url text;
  token text;
  job_id bigint;
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can work with platform connections' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.platform_connections where id = p_connection) then
    raise exception 'No such platform connection' using errcode = 'no_data_found';
  end if;
  if p_kind is distinct from 'check' then
    raise exception 'Unknown job kind %', p_kind using errcode = 'check_violation';
  end if;

  -- Jobs the site never answered count as failed after two minutes.
  update public.platform_jobs set finished_at = now(), ok = false,
         message = case when claimed_at is null then 'Our site did not pick up the job within 2 minutes.'
                        else 'Our site did not report back within 2 minutes.' end
   where finished_at is null and created_at < now() - interval '2 minutes';

  -- Pressing the button twice does not start two jobs.
  select id into job_id from public.platform_jobs
   where connection_id = p_connection and kind = p_kind and finished_at is null
   order by id desc limit 1;
  if job_id is not null then return job_id; end if;

  token := public.new_secret('pjt_');
  insert into public.platform_jobs (connection_id, kind, requested_by, token_hash)
  values (p_connection, p_kind, auth.uid(), public.secret_hash(token))
  returning id into job_id;

  select site_url into url from public.push_config;
  if url is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    update public.platform_jobs set finished_at = now(), ok = false,
           message = 'This database does not know its site address yet (run the Database migrations workflow).'
     where id = job_id;
  else
    execute 'select net.http_post(url := $1, body := $2, timeout_milliseconds := 5000)'
      using url || '/api/v1/platforms/run', jsonb_build_object('token', token);
  end if;
  return job_id;
end $$;

-- ---------------------------------------------------------------------------
-- Running a job (our Cloudflare API, with the public key, so as role anon; only the token holder gets anything)
-- ---------------------------------------------------------------------------
create function public.platform_job_claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.platform_jobs;
  c public.platform_connections;
begin
  select * into j from public.platform_jobs where token_hash = public.secret_hash(coalesce(p_token, '')) for update;
  if not found or j.claimed_at is not null or j.finished_at is not null or j.created_at < now() - interval '10 minutes' then
    raise exception 'Invalid or used job token' using errcode = 'invalid_authorization_specification';
  end if;
  update public.platform_jobs set claimed_at = now() where id = j.id;
  select * into c from public.platform_connections where id = j.connection_id;
  return jsonb_build_object(
    'job', j.id,
    'kind', j.kind,
    'connection', jsonb_build_object('id', c.id, 'kind', c.kind, 'name', c.name, 'base_url', c.base_url,
      'secret', (select secret from public.platform_secrets where connection_id = c.id)));
end $$;

create function public.platform_job_report(p_token text, p_ok boolean, p_message text, p_result jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
declare j public.platform_jobs;
begin
  select * into j from public.platform_jobs where token_hash = public.secret_hash(coalesce(p_token, '')) for update;
  if not found or j.claimed_at is null or j.finished_at is not null or j.claimed_at < now() - interval '10 minutes' then
    raise exception 'Invalid or used job token' using errcode = 'invalid_authorization_specification';
  end if;
  if p_ok is null then
    raise exception 'ok must be true or false' using errcode = 'check_violation';
  end if;
  if p_result is not null and pg_column_size(p_result) > 65536 then
    raise exception 'The result is too large' using errcode = 'check_violation';
  end if;
  update public.platform_jobs
     set finished_at = now(), ok = p_ok, message = left(coalesce(nullif(btrim(p_message), ''), case when p_ok then 'Done' else 'Failed' end), 1000),
         result = p_result
   where id = j.id;
end $$;

-- Old jobs are kept 30 days (pg_cron, daily).
create function public.platform_jobs_prune() returns integer
language sql security definer set search_path = '' as $$
  with gone as (delete from public.platform_jobs where created_at < now() - interval '30 days' returning 1)
  select count(*)::integer from gone
$$;

do $$
begin
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'platform-jobs-prune') then
      perform cron.unschedule('platform-jobs-prune');
    end if;
    perform cron.schedule('platform-jobs-prune', '17 3 * * *', 'select public.platform_jobs_prune()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on function public.platform_configure(text, text, text, text), public.platform_job_start(uuid, text),
  public.platform_job_claim(text), public.platform_job_report(text, boolean, text, jsonb), public.platform_jobs_prune()
  from public, anon, authenticated;
grant execute on function public.platform_job_start(uuid, text) to authenticated;
grant execute on function public.platform_job_claim(text), public.platform_job_report(text, boolean, text, jsonb) to anon;
