import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

describe('roles and row-level security (task 1.3)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let lending: string
  let paymentsAgent: string
  let lendingAgent: string

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    lending = await createDepartment(db, 'Lending')
    u.ownerA = await createUser(db, 'owner.a@bank.test', ['owner'])
    u.ownerB = await createUser(db, 'owner.b@bank.test', ['owner'])
    u.approver = await createUser(db, 'approver@bank.test', ['approver'])
    u.executive = await createUser(db, 'exec@bank.test', ['executive'])
    u.auditor = await createUser(db, 'audit@bank.test', ['auditor'])
    u.admin = await createUser(db, 'admin@bank.test', ['admin'])
    u.nobody = await createUser(db, 'nobody@bank.test', [])
    await grantScope(db, u.approver, payments)
    paymentsAgent = await proposeAgent(db, u.ownerA, { name: 'Payments bot', department_id: payments })
    lendingAgent = await proposeAgent(db, u.ownerB, { name: 'Lending bot', department_id: lending })
  })

  const visibleAgents = (userId: string) =>
    asUser(db, userId, async (tx) => (await tx.query<{ name: string }>(`select name from public.agents order by name`)).rows.map((r) => r.name))

  it('owners see only the agents they own or created', async () => {
    expect(await visibleAgents(u.ownerA)).toEqual(['Payments bot'])
    expect(await visibleAgents(u.ownerB)).toEqual(['Lending bot'])
  })

  it('approvers see only agents in the departments they approve for', async () => {
    expect(await visibleAgents(u.approver)).toEqual(['Payments bot'])
  })

  it('executives, auditors and admins see every agent', async () => {
    for (const who of [u.executive, u.auditor, u.admin]) {
      expect(await visibleAgents(who)).toEqual(['Lending bot', 'Payments bot'])
    }
  })

  it('a user with no role sees nothing, and anonymous visitors cannot read agents at all', async () => {
    expect(await visibleAgents(u.nobody)).toEqual([])
    await expect(asRole(db, 'anon', (tx) => tx.query(`select * from public.agents`))).rejects.toThrow(/permission denied/)
  })

  it('only owners and admins can propose agents', async () => {
    await expect(proposeAgent(db, u.executive, { name: 'Sneaky' })).rejects.toThrow(/row-level security/)
    await expect(proposeAgent(db, u.approver, { name: 'Sneaky' })).rejects.toThrow(/row-level security/)
  })

  it('owners cannot edit agents that are not theirs', async () => {
    const res = await asUser(db, u.ownerB, (tx) =>
      tx.query(`update public.agents set description = 'hijack' where id = $1`, [paymentsAgent]))
    expect(res.affectedRows).toBe(0)
  })

  it('nobody can set status or review dates directly, not even an admin', async () => {
    // Two layers: the column is not writable through the API, and the lifecycle trigger refuses it anyway.
    await expect(
      asUser(db, u.admin, (tx) => tx.query(`update public.agents set status = 'live' where id = $1`, [lendingAgent])),
    ).rejects.toThrow(/permission denied/)
    await expect(
      db.query(`update public.agents set status = 'live' where id = $1`, [lendingAgent]),
    ).rejects.toThrow(/approval workflow/)
  })

  it('the audit trail follows the same scope', async () => {
    const count = (userId: string) =>
      asUser(db, userId, async (tx) =>
        (await tx.query<{ n: number }>(`select count(distinct agent_id)::int n from public.audit_events where agent_id is not null`)).rows[0].n)
    expect(await count(u.ownerA)).toBe(1)
    expect(await count(u.auditor)).toBe(2)
  })

  it('only admins manage roles', async () => {
    await expect(
      asUser(db, u.ownerA, (tx) => tx.query(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [u.ownerA])),
    ).rejects.toThrow(/row-level security/)
    await asUser(db, u.admin, (tx) => tx.query(`insert into public.user_roles (user_id, role) values ($1, 'auditor')`, [u.nobody]))
  })
})
