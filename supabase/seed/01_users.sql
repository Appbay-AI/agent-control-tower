-- Demo personas for Northbridge Bank (fictional). Run by the "Seed demo data" workflow:
--   psql "$SUPABASE_DB_URL" -v demo_password="$DEMO_USER_PASSWORD" -f supabase/seed/01_users.sql
-- Idempotent: creates missing users and resets every persona's password to demo_password.
-- Writes to Supabase's auth schema directly, the same way Supabase's own seed examples do.

select set_config('seed.password', :'demo_password', false);

do $$
declare
  p record;
  uid uuid;
  pw text := current_setting('seed.password');
begin
  if length(coalesce(pw, '')) < 12 then
    raise exception 'DEMO_USER_PASSWORD must be at least 12 characters';
  end if;

  for p in
    select * from (values
      ('admin@northbridge.demo',           'Platform Admin'),
      ('priya.sharma@northbridge.demo',    'Priya Sharma'),
      ('ravi.menon@northbridge.demo',      'Ravi Menon'),
      ('daniel.okafor@northbridge.demo',   'Daniel Okafor'),
      ('sara.haddad@northbridge.demo',     'Sara Haddad'),
      ('omar.farouk@northbridge.demo',     'Omar Farouk'),
      ('james.whitfield@northbridge.demo', 'James Whitfield'),
      ('aisha.rahman@northbridge.demo',    'Aisha Rahman'),
      ('tom.becker@northbridge.demo',      'Tom Becker'),
      ('lucy.grant@northbridge.demo',      'Lucy Grant'),
      ('mei.lin@northbridge.demo',         'Mei Lin')
    ) as t(email, full_name)
  loop
    select id into uid from auth.users where email = p.email;
    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, email_change, email_change_token_new, recovery_token)
      values (
        '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', p.email,
        extensions.crypt(pw, extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', p.full_name), now(), now(),
        '', '', '', '');
      insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (uid::text, uid, jsonb_build_object('sub', uid::text, 'email', p.email, 'email_verified', true),
              'email', now(), now(), now());
      raise notice 'created %', p.email;
    else
      update auth.users set encrypted_password = extensions.crypt(pw, extensions.gen_salt('bf')), updated_at = now()
      where id = uid;
    end if;
  end loop;
end $$;

select set_config('seed.password', '', false);
