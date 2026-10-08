import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, proposeAgent } from './harness'

describe('user administration', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let lending: string

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    lending = await createDepartment(db, 'Lending')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'])
    u.owner = await createUser(db, 'owner@bank.test', ['owner'])
  })

  const createViaAdmin = (who: string, email: string, roles: string[] = ['owner'], scopes: string[] = []) =>
    asUser(db, who, async (tx) => (await tx.query<{ r: { id: string; temporary_password: string } }>(
      `select public.admin_create_user($1, 'New Person', 'Analyst', $2, $3::public.app_role[], $4::uuid[]) r`,
      [email, payments, `{${roles.join(',')}}`, `{${scopes.join(',')}}`])).rows[0].r)

  const listAs = (who: string) =>
    asUser(db, who, async (tx) => (await tx.query<{ email: string; roles: string[]; is_active: boolean; owned_agents: number }>(
      `select email, roles::text[] roles, is_active, owned_agents from public.admin_list_users()`)).rows)

  it('an admin adds a person, with roles, approval departments and a one-time password', async () => {
    const r = await createViaAdmin(u.admin, '  New.Approver@Bank.test ', ['approver'], [payments, lending])
    expect(r.temporary_password).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/)
    const { rows } = await db.query<{ email: string; must_change_password: boolean; department_id: string; job_title: string; pw: string }>(
      `select p.email, p.must_change_password, p.department_id, p.job_title, u.encrypted_password pw
       from public.profiles p join auth.users u on u.id = p.id where p.id = $1`, [r.id])
    expect(rows[0]).toMatchObject({ email: 'new.approver@bank.test', must_change_password: true, department_id: payments, job_title: 'Analyst' })
    expect(rows[0].pw).not.toContain(r.temporary_password) // only a hash is stored
    const scopes = await db.query(`select 1 from public.approver_scopes where user_id = $1`, [r.id])
    expect(scopes.rows).toHaveLength(2)
    const identities = await db.query(`select 1 from auth.identities where user_id = $1`, [r.id])
    expect(identities.rows).toHaveLength(1)
  })

  it('refuses duplicates, bad emails and approvers with no department', async () => {
    await expect(createViaAdmin(u.admin, 'OWNER@bank.test')).rejects.toThrow(/already has an account/)
    await expect(createViaAdmin(u.admin, 'not-an-email')).rejects.toThrow(/valid email/)
    await expect(createViaAdmin(u.admin, 'lonely.approver@bank.test', ['approver'], [])).rejects.toThrow(/at least one department/)
  })

  it('only admins can list or manage users', async () => {
    await expect(createViaAdmin(u.owner, 'sneaky@bank.test')).rejects.toThrow(/Only admins/)
    await expect(listAs(u.owner)).rejects.toThrow(/Only admins/)
    await expect(asUser(db, u.owner, (tx) => tx.query(`select public.admin_reset_password($1)`, [u.admin]))).rejects.toThrow(/Only admins/)
    // People cannot grant themselves roles or reactivate themselves through the tables either.
    await expect(asUser(db, u.owner, (tx) => tx.query(`insert into public.user_roles values ($1, 'admin')`, [u.owner])))
      .rejects.toThrow(/row-level security/)
    await expect(asUser(db, u.owner, (tx) => tx.query(`update public.profiles set is_active = true where id = $1`, [u.owner])))
      .rejects.toThrow(/permission denied/)
  })

  it('updating access replaces roles exactly; removing Approver removes their departments', async () => {
    const r = await createViaAdmin(u.admin, 'switcher@bank.test', ['approver'], [lending])
    await asUser(db, u.admin, (tx) => tx.query(
      `select public.admin_update_user($1, 'Switched Person', null, $2, '{owner,auditor}', '{}')`, [r.id, lending]))
    const list = await listAs(u.admin)
    expect(list.find((x) => x.email === 'switcher@bank.test')?.roles).toEqual(['owner', 'auditor'])
    expect((await db.query(`select 1 from public.approver_scopes where user_id = $1`, [r.id])).rows).toHaveLength(0)
  })

  it('an admin cannot remove their own Admin role or deactivate themselves; one active admin must remain', async () => {
    await expect(asUser(db, u.admin, (tx) => tx.query(
      `select public.admin_update_user($1, 'Admin', null, null, '{owner}', '{}')`, [u.admin]))).rejects.toThrow(/own Admin role/)
    await expect(asUser(db, u.admin, (tx) => tx.query(
      `select public.admin_set_user_active($1, false, 'bye')`, [u.admin]))).rejects.toThrow(/own account/)
    const second = await createUser(db, 'admin2@bank.test', ['admin'])
    await asUser(db, second, (tx) => tx.query(`select public.admin_set_user_active($1, false, 'Left')`, [u.admin]))
    // second is now the only active admin and cannot be removed by anyone
    await db.query(`select set_config('request.jwt.claims', '', false)`)
    await expect(db.query(`delete from public.user_roles where user_id = $1 and role = 'admin'`, [second]))
      .rejects.toThrow(/active admin must remain/)
    await asUser(db, second, (tx) => tx.query(`select public.admin_set_user_active($1, true, null)`, [u.admin]))
  })

  it('a password reset issues a new one-time password and forces a change at next sign-in', async () => {
    const before = (await db.query<{ p: string }>(`select encrypted_password p from auth.users where id = $1`, [u.owner])).rows[0].p
    const pw = await asUser(db, u.admin, async (tx) =>
      (await tx.query<{ pw: string }>(`select public.admin_reset_password($1) pw`, [u.owner])).rows[0].pw)
    expect(pw).toMatch(/^[0-9a-f-]{19}$/)
    const after = await db.query<{ p: string; must: boolean }>(
      `select u.encrypted_password p, pr.must_change_password must from auth.users u join public.profiles pr on pr.id = u.id where u.id = $1`, [u.owner])
    expect(after.rows[0].p).not.toBe(before)
    expect(after.rows[0].must).toBe(true)
    await asUser(db, u.owner, (tx) => tx.query(`select public.password_changed()`))
    expect((await db.query<{ m: boolean }>(`select must_change_password m from public.profiles where id = $1`, [u.owner])).rows[0].m).toBe(false)
  })

  it('deactivating someone blocks sign-in, hides everything from them and flags the agents they owned', async () => {
    const leaver = await createUser(db, 'leaver@bank.test', ['owner'])
    const agent = await proposeAgent(db, leaver, { name: 'Leaver bot', department_id: payments })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [agent])
    await db.query(`update public.agents set status = 'live' where id = $1`, [agent])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)

    const visible = () => asUser(db, leaver, async (tx) => (await tx.query(`select 1 from public.agents`)).rows.length)
    expect(await visible()).toBe(1)
    expect((await listAs(u.admin)).find((x) => x.email === 'leaver@bank.test')?.owned_agents).toBe(1)

    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.admin_set_user_active($1, false, '  ')`, [leaver])))
      .rejects.toThrow(/Give a reason/)
    await asUser(db, u.admin, (tx) => tx.query(`select public.admin_set_user_active($1, false, 'Left the bank')`, [leaver]))

    expect(await visible()).toBe(0)
    const banned = await db.query<{ b: boolean }>(`select banned_until > now() b from auth.users where id = $1`, [leaver])
    expect(banned.rows[0].b).toBe(true)
    const alerts = await db.query<{ message: string }>(
      `select message from public.alerts where agent_id = $1 and kind = 'owner_missing' and resolved_at is null`, [agent])
    expect(alerts.rows[0].message).toMatch(/business owner leaver has been deactivated/)
    const audit = await db.query<{ reason: string }>(
      `select reason from public.audit_events where entity_type = 'profiles' and entity_id = $1 order by seq desc limit 1`, [leaver])
    expect(audit.rows[0].reason).toBe('Left the bank')

    await asUser(db, u.admin, (tx) => tx.query(`select public.admin_set_user_active($1, true, null)`, [leaver]))
    expect(await visible()).toBe(1)
    const open = await db.query(`select 1 from public.alerts where agent_id = $1 and kind = 'owner_missing' and resolved_at is null`, [agent])
    expect(open.rows).toHaveLength(0)
  })

  it('people can still edit their own name, but not their roles or status', async () => {
    await asUser(db, u.owner, (tx) => tx.query(`update public.profiles set full_name = 'Olive Owner' where id = $1`, [u.owner]))
    expect((await db.query<{ n: string }>(`select full_name n from public.profiles where id = $1`, [u.owner])).rows[0].n).toBe('Olive Owner')
  })
})
