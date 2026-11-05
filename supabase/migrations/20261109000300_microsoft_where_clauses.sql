-- Task 3.1 (resumed), fix: Supabase refuses UPDATE or DELETE without a WHERE clause on requests that come through its
-- web API (pg_safeupdate). The report of the Microsoft checks (and Disconnect) updated the one-row tables without one,
-- so every report was refused. Same functions, now naming the row.

create or replace function public.microsoft_check_report(p_token text, p_ok boolean, p_message text, p_results jsonb, p_refresh_token text default null)
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
    update public.microsoft_connection set refresh_token = p_refresh_token, refreshed_at = now() where id;
  end if;
end $$;

create or replace function public.microsoft_disconnect() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role('admin') then
    raise exception 'Only admins can disconnect Microsoft' using errcode = 'insufficient_privilege';
  end if;
  delete from public.microsoft_connection where id;
  if found then perform public.microsoft_audit('microsoft_connection.disconnected', 'Microsoft disconnected', auth.uid()); end if;
end $$;

create or replace function public.microsoft_configure(p_tenant text, p_client text, p_secret text) returns text
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
    update public.microsoft_app set tenant_id = t, client_id = c, updated_at = now() where id returning * into a;
    -- A sign-in belongs to one app registration.
    delete from public.microsoft_connection where id;
    outcome := 'updated (the earlier sign-in was removed)';
  else
    outcome := 'unchanged';
  end if;
  if coalesce(p_secret, '') <> '' and a.client_secret is distinct from p_secret then
    update public.microsoft_app set client_secret = p_secret, secret_set_at = now(), updated_at = now() where id;
    outcome := outcome || ', secret stored';
  elsif a.client_secret is null and coalesce(p_secret, '') = '' then
    outcome := outcome || ', no secret yet';
  end if;
  return outcome;
end $$;
