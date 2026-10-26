import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

/** What Supabase provides that plain Postgres does not: API roles, auth.users and auth.uid(). */
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    instance_id uuid,
    id uuid primary key default gen_random_uuid(),
    aud text,
    role text,
    email text unique,
    encrypted_password text,
    email_confirmed_at timestamptz,
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb not null default '{}',
    created_at timestamptz,
    updated_at timestamptz,
    last_sign_in_at timestamptz,
    banned_until timestamptz,
    confirmation_token text,
    email_change text,
    email_change_token_new text,
    recovery_token text
  );
  create table auth.identities (
    provider_id text not null,
    user_id uuid not null references auth.users (id) on delete cascade,
    identity_data jsonb not null,
    provider text not null,
    last_sign_in_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz,
    primary key (provider, provider_id)
  );
  -- Stand-ins for pgcrypto, which Supabase installs in the extensions schema.
  create schema extensions;
  create function extensions.gen_salt(text) returns text language sql as $$ select 'salt' $$;
  create function extensions.crypt(pw text, salt text) returns text language sql as $$ select 'hash:' || md5(pw) $$;
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  -- Real pgcrypto for HMAC signatures (task 2.8), in its own schema so the fast stand-ins above stay as they are.
  create schema pgcrypto_real;
  create extension pgcrypto with schema pgcrypto_real;
  create function extensions.hmac(data text, key text, type text) returns bytea language sql immutable
    as $$ select pgcrypto_real.hmac(data, key, type) $$;
  grant usage on schema extensions to anon, authenticated, service_role;
  -- Stand-in for pg_net (task 2.6): records each call instead of making it.
  create schema net;
  create table net.calls (id serial primary key, url text, body jsonb, at timestamptz default now());
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
                                headers jsonb default '{}', timeout_milliseconds integer default 2000)
  returns bigint language sql as $$ insert into net.calls (url, body) values (url, body) returning id $$;
`

const MIGRATIONS_DIR = path.resolve(__dirname, '../supabase/migrations')

export type Role = 'admin' | 'approver' | 'owner' | 'executive' | 'auditor'

export async function createDb() {
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(SUPABASE_STUB)
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
    } catch (e) {
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`)
    }
  }
  return db
}

export async function createUser(db: PGlite, email: string, roles: Role[] = [], fullName = email.split('@')[0]) {
  const { rows } = await db.query<{ id: string }>(
    `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text)) returning id`,
    [email, fullName],
  )
  const id = rows[0].id
  for (const role of roles) {
    await db.query(`insert into public.user_roles (user_id, role) values ($1, $2)`, [id, role])
  }
  return id
}

export async function createDepartment(db: PGlite, name: string) {
  const { rows } = await db.query<{ id: string }>(`insert into public.departments (name) values ($1) returning id`, [name])
  return rows[0].id
}

export async function grantScope(db: PGlite, userId: string, departmentId: string) {
  await db.query(`insert into public.approver_scopes (user_id, department_id) values ($1, $2)`, [userId, departmentId])
}

/** Runs fn as a signed-in user, exactly as PostgREST would: role authenticated + JWT claims. */
export async function asUser<T>(db: PGlite, userId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role authenticated`)
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })])
    return fn(tx)
  })
}

export async function asRole<T>(db: PGlite, role: 'anon' | 'service_role', fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`)
    return fn(tx)
  })
}

/** Inserts a minimal valid agent as a user (owner role required by policy). */
export async function proposeAgent(
  db: PGlite,
  userId: string,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const values = { name: 'Test agent', purpose_statement: 'Reconcile invoices', business_owner_id: userId, created_by: userId, ...fields }
  const cols = Object.keys(values)
  const params = Object.values(values)
  return asUser(db, userId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.agents (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      params,
    )
    return rows[0].id
  })
}
