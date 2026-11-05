-- Task 3.1 (Microsoft spike), resumed 5 Nov: "Connect Microsoft". The tenant's security defaults refuse the device-code
-- sign-in the first spike used, so an admin now signs in to Microsoft in the browser (normal sign-in, with MFA and
-- consent), Microsoft sends the browser back to our API with a one-time code, and our API swaps it for a renewable
-- sign-in (refresh token). That sign-in is kept in a locked table, like the Appian key; only our API gets it, with a
-- single-use token. "Run Microsoft checks" then tests, from our API, what the Microsoft requirements rely on.
--
-- The app registration's IDs and client secret reach the database from GitHub (variables MS_TENANT_ID and MS_CLIENT_ID,
-- secret MS_CLIENT_SECRET) through the Database migrations workflow (scripts/microsoft-setup.mjs). Nothing here is
-- readable from the app except what microsoft_status() chooses to show.

-- The app registration (one per database). Locked: no policies, no grants.
create table public.microsoft_app (
  id boolean primary key default true check (id),
  tenant_id text not null check (tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  client_id text not null check (client_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  client_secret text check (length(client_secret) between 1 and 400),
  secret_set_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.microsoft_app enable row level security;
revoke all on public.microsoft_app from anon, authenticated;

-- The admin's renewable sign-in. Locked.
create table public.microsoft_connection (
  id boolean primary key default true check (id),
  refresh_token text not null check (length(refresh_token) between 1 and 20000),
  account text,                 -- the Microsoft account that signed in
  account_name text,
  connected_by uuid references public.profiles (id) on delete set null,
  connected_at timestamptz not null default now(),
  refreshed_at timestamptz
);
alter table public.microsoft_connection enable row level security;
revoke all on public.microsoft_connection from anon, authenticated;

-- Sign-ins in progress: the "state" sent to Microsoft and the PKCE verifier. Locked; usable once, for 10 minutes.
create table public.microsoft_signins (
  state_hash text primary key,
  code_verifier text not null,
  redirect_uri text not null,
  requested_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);
alter table public.microsoft_signins enable row level security;
revoke all on public.microsoft_signins from anon, authenticated;

-- Each "Run Microsoft checks" and its results (admins read them; the token hash stays hidden).
create table public.microsoft_checks (
  id bigint generated always as identity primary key,
  requested_by uuid references public.profiles (id) on delete set null,
  test_agent text check (length(test_agent) <= 200),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  ok boolean,
  message text check (length(message) <= 1000),
  results jsonb check (pg_column_size(results) <= 65536)
);
alter table public.microsoft_checks enable row level security;
create policy "admins see microsoft checks" on public.microsoft_checks for select to authenticated using (public.has_role('admin'));
revoke all on public.microsoft_checks from anon, authenticated;
grant select (id, requested_by, test_agent, created_at, claimed_at, finished_at, ok, message, results) on public.microsoft_checks to authenticated;

-- Changes to the connection, on the record (these tables have no uuid id, so the generic audit trigger does not fit).
create function public.microsoft_audit(p_action text, p_summary text, p_actor uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_events (actor_id, actor_type, action, entity_type, summary)
  values (p_actor, case when p_actor is null then 'system' else 'user' end, p_action, 'microsoft_connection', p_summary)
$$;

-- ---------------------------------------------------------------------------
-- Set up the app registration (Database migrations workflow, as the database owner; nobody else may)
-- ---------------------------------------------------------------------------
create function public.microsoft_configure(p_tenant text, p_client text, p_secret text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  a public.microsoft_app;
  t text := lower(btrim(coalesce(p_tenant, '')));
  c text := lower(btrim(coalesce(p_client, '')));
  outcome text;
begin
  select * into a from public.microsoft_app;
  if not found then
    insert into public.microsoft_app (tenant_id, client_id) values (t, c) returning * into a;
    outcome := 'created';
  elsif a.tenant_id <> t or a.client_id <> c then
    update public.microsoft_app set tenant_id = t, client_id = c, updated_at = now() returning * into a;
    -- A sign-in belongs to one app registration.
    delete from public.microsoft_connection;
    outcome := 'updated (the earlier sign-in was removed)';
  else
    outcome := 'unchanged';
  end if;
  if coalesce(p_secret, '') <> '' and a.client_secret is distinct from p_secret then
    update public.microsoft_app set client_secret = p_secret, secret_set_at = now(), updated_at = now();
    outcome := outcome || ', secret stored';
  elsif a.client_secret is null and coalesce(p_secret, '') = '' then
    outcome := outcome || ', no secret yet';
  end if;
  return outcome;
end $$;

-- ---------------------------------------------------------------------------
-- What the Integrations page shows (admins). Never the secret or the sign-in itself.
-- ---------------------------------------------------------------------------
create function public.microsoft_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a public.microsoft_app;
  c public.microsoft_connection;
  site text;
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can see the Microsoft connection' using errcode = 'insufficient_privilege';
  end if;
  select * into a from public.microsoft_app;
  select * into c from public.microsoft_connection;
  select site_url into site from public.push_config;
  return jsonb_build_object(
    'app', a.id is not null, 'tenant_id', a.tenant_id, 'client_id', a.client_id, 'secret_set', a.client_secret is not null,
    'secret_set_at', a.secret_set_at, 'redirect_uri', case when site is not null then site || '/api/v1/microsoft/callback' end,
    'connected', c.id is not null, 'account', c.account, 'account_name', c.account_name,
    'connected_by', (select full_name from public.profiles where id = c.connected_by), 'connected_at', c.connected_at,
    'refreshed_at', c.refreshed_at);
end $$;

-- ---------------------------------------------------------------------------
-- Sign in: start (admin, from the app). Returns what the browser needs to go to Microsoft.
-- ---------------------------------------------------------------------------
create function public.microsoft_connect_start() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.microsoft_app;
  site text;
  state text := public.new_secret('mss_');
  verifier text := public.new_secret('');
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can connect Microsoft' using errcode = 'insufficient_privilege';
  end if;
  select * into a from public.microsoft_app;
  if not found then
    raise exception 'The Microsoft app registration is not set up on this database yet (GitHub variables MS_TENANT_ID and MS_CLIENT_ID, then the Database migrations workflow)' using errcode = 'check_violation';
  end if;
  if a.client_secret is null then
    raise exception 'The Microsoft client secret is not stored yet (GitHub secret MS_CLIENT_SECRET, then the Database migrations workflow)' using errcode = 'check_violation';
  end if;
  select site_url into site from public.push_config;
  if site is null then
    raise exception 'This database does not know its site address yet (run the Database migrations workflow)' using errcode = 'check_violation';
  end if;
  delete from public.microsoft_signins where created_at < now() - interval '1 day';
  insert into public.microsoft_signins (state_hash, code_verifier, redirect_uri, requested_by)
  values (public.secret_hash(state), verifier, site || '/api/v1/microsoft/callback', auth.uid());
  return jsonb_build_object(
    'authorize_url', format('https://login.microsoftonline.com/%s/oauth2/v2.0/authorize', a.tenant_id),
    'client_id', a.client_id,
    'redirect_uri', site || '/api/v1/microsoft/callback',
    'scope', 'https://api.powerplatform.com/.default offline_access openid profile',
    'state', state,
    'code_challenge', translate(rtrim(encode(sha256(convert_to(verifier, 'UTF8')), 'base64'), '='), '+/', '-_'),
    'code_challenge_method', 'S256');
end $$;

-- Sign in: our API (role anon, holding the state Microsoft sent back) gets what it needs to swap the code.
create function public.microsoft_connect_claim(p_state text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.microsoft_signins;
  a public.microsoft_app;
begin
  select * into s from public.microsoft_signins where state_hash = public.secret_hash(coalesce(p_state, '')) for update;
  if not found or s.claimed_at is not null or s.created_at < now() - interval '10 minutes' then
    raise exception 'This sign-in link has expired or was already used. Start again with Connect Microsoft.' using errcode = 'invalid_authorization_specification';
  end if;
  update public.microsoft_signins set claimed_at = now() where state_hash = s.state_hash;
  select * into a from public.microsoft_app;
  return jsonb_build_object('tenant_id', a.tenant_id, 'client_id', a.client_id, 'client_secret', a.client_secret,
    'code_verifier', s.code_verifier, 'redirect_uri', s.redirect_uri);
end $$;

-- Sign in: our API stores the renewable sign-in.
create function public.microsoft_connect_finish(p_state text, p_refresh_token text, p_account text, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.microsoft_signins;
begin
  select * into s from public.microsoft_signins where state_hash = public.secret_hash(coalesce(p_state, '')) for update;
  if not found or s.claimed_at is null or s.finished_at is not null or s.claimed_at < now() - interval '10 minutes' then
    raise exception 'Invalid or used sign-in' using errcode = 'invalid_authorization_specification';
  end if;
  if length(coalesce(p_refresh_token, '')) = 0 then
    raise exception 'Microsoft did not return a renewable sign-in' using errcode = 'check_violation';
  end if;
  update public.microsoft_signins set finished_at = now() where state_hash = s.state_hash;
  insert into public.microsoft_connection (refresh_token, account, account_name, connected_by, connected_at, refreshed_at)
  values (p_refresh_token, left(p_account, 200), left(p_name, 200), s.requested_by, now(), now())
  on conflict (id) do update set refresh_token = excluded.refresh_token, account = excluded.account, account_name = excluded.account_name,
    connected_by = excluded.connected_by, connected_at = excluded.connected_at, refreshed_at = excluded.refreshed_at;
  perform public.microsoft_audit('microsoft_connection.connected',
    format('Microsoft connected as %s', coalesce(nullif(p_account, ''), 'an unnamed account')), s.requested_by);
end $$;

create function public.microsoft_disconnect() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can disconnect Microsoft' using errcode = 'insufficient_privilege';
  end if;
  delete from public.microsoft_connection;
  if found then perform public.microsoft_audit('microsoft_connection.disconnected', 'Microsoft disconnected', auth.uid()); end if;
end $$;

-- ---------------------------------------------------------------------------
-- Run the checks: start (admin), claim and report (our API with the single-use token)
-- ---------------------------------------------------------------------------
create function public.microsoft_check_start(p_test_agent text default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  url text;
  token text;
  check_id bigint;
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can run the Microsoft checks' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.microsoft_connection) then
    raise exception 'Connect Microsoft first' using errcode = 'check_violation';
  end if;
  update public.microsoft_checks set finished_at = now(), ok = false,
         message = case when claimed_at is null then 'Our site did not pick up the checks within 3 minutes.'
                        else 'Our site did not report back within 3 minutes.' end
   where finished_at is null and created_at < now() - interval '3 minutes';
  select id into check_id from public.microsoft_checks where finished_at is null order by id desc limit 1;
  if check_id is not null then return check_id; end if;

  token := public.new_secret('mct_');
  insert into public.microsoft_checks (requested_by, test_agent, token_hash)
  values (auth.uid(), nullif(btrim(coalesce(p_test_agent, '')), ''), public.secret_hash(token))
  returning id into check_id;
  select site_url into url from public.push_config;
  if url is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    update public.microsoft_checks set finished_at = now(), ok = false,
           message = 'This database does not know its site address yet (run the Database migrations workflow).' where id = check_id;
  else
    execute 'select net.http_post(url := $1, body := $2, timeout_milliseconds := 5000)'
      using url || '/api/v1/microsoft/run', jsonb_build_object('token', token);
  end if;
  return check_id;
end $$;

create function public.microsoft_check_claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k public.microsoft_checks;
  a public.microsoft_app;
  c public.microsoft_connection;
begin
  select * into k from public.microsoft_checks where token_hash = public.secret_hash(coalesce(p_token, '')) for update;
  if not found or k.claimed_at is not null or k.finished_at is not null or k.created_at < now() - interval '10 minutes' then
    raise exception 'Invalid or used token' using errcode = 'invalid_authorization_specification';
  end if;
  update public.microsoft_checks set claimed_at = now() where id = k.id;
  select * into a from public.microsoft_app;
  select * into c from public.microsoft_connection;
  return jsonb_build_object('check', k.id, 'test_agent', k.test_agent, 'tenant_id', a.tenant_id, 'client_id', a.client_id,
    'client_secret', a.client_secret, 'refresh_token', c.refresh_token);
end $$;

-- p_refresh_token: Microsoft hands out a new renewable sign-in each time one is used; the newest is kept.
create function public.microsoft_check_report(p_token text, p_ok boolean, p_message text, p_results jsonb, p_refresh_token text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare k public.microsoft_checks;
begin
  select * into k from public.microsoft_checks where token_hash = public.secret_hash(coalesce(p_token, '')) for update;
  if not found or k.claimed_at is null or k.finished_at is not null or k.claimed_at < now() - interval '10 minutes' then
    raise exception 'Invalid or used token' using errcode = 'invalid_authorization_specification';
  end if;
  if p_results is not null and pg_column_size(p_results) > 65536 then
    raise exception 'The results are too large' using errcode = 'check_violation';
  end if;
  update public.microsoft_checks set finished_at = now(), ok = coalesce(p_ok, false),
         message = left(coalesce(nullif(btrim(p_message), ''), case when p_ok then 'Done' else 'Failed' end), 1000), results = p_results
   where id = k.id;
  if coalesce(p_refresh_token, '') <> '' then
    update public.microsoft_connection set refresh_token = p_refresh_token, refreshed_at = now();
  end if;
end $$;

revoke execute on function public.microsoft_configure(text, text, text), public.microsoft_audit(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.microsoft_status(), public.microsoft_connect_start(), public.microsoft_disconnect(),
  public.microsoft_check_start(text) from public, anon;
grant execute on function public.microsoft_status(), public.microsoft_connect_start(), public.microsoft_disconnect(),
  public.microsoft_check_start(text) to authenticated;
revoke execute on function public.microsoft_connect_claim(text), public.microsoft_connect_finish(text, text, text, text),
  public.microsoft_check_claim(text), public.microsoft_check_report(text, boolean, text, jsonb, text) from public, authenticated;
grant execute on function public.microsoft_connect_claim(text), public.microsoft_connect_finish(text, text, text, text),
  public.microsoft_check_claim(text), public.microsoft_check_report(text, boolean, text, jsonb, text) to anon;
