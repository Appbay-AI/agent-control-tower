import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite, type Transaction } from '@electric-sql/pglite'

/** What Supabase provides that plain Postgres does not: API roles, auth.users and auth.uid(). */
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_user_meta_data jsonb not null default '{}'
  );
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`

const MIGRATIONS_DIR = path.resolve(__dirname, '../supabase/migrations')

export type Role = 'admin' | 'approver' | 'owner' | 'executive' | 'auditor'

export async function createDb() {
  const db = new PGlite()
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
