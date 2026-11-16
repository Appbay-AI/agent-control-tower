import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 4.10: reads check visibility once per read (visible_agent_ids) instead of once per row (can_see_agent).
// Who sees what must not change: for every kind of person, the two give the same agents, and every table follows.
describe('visibility worked out once per read (task 4.10)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  const agents: Record<string, string> = {}

  beforeAll(async () => {
    db = await createDb()
    const payments = await createDepartment(db, 'Payments')
    const hr = await createDepartment(db, 'HR')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'])
    u.cro = await createUser(db, 'cro@bank.test', ['executive'])
    u.audit = await createUser(db, 'audit@bank.test', ['auditor'])
    u.james = await createUser(db, 'james@bank.test', ['owner'])
    u.tech = await createUser(db, 'tech@bank.test', ['owner'])
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'])
    u.omar = await createUser(db, 'omar@bank.test', ['approver'])
    u.nobody = await createUser(db, 'nobody@bank.test', [])
    u.gone = await createUser(db, 'gone@bank.test', ['admin'])
    await grantScope(db, u.ravi, payments)
    agents.pay = await proposeAgent(db, u.james, { name: 'Payment Bot', department_id: payments })
    agents.hr = await proposeAgent(db, u.admin, { name: 'HR Bot', department_id: hr })
    agents.tech = await proposeAgent(db, u.admin, { name: 'Tech Bot', department_id: hr })
    await db.query(`update public.agents set technical_owner_id = $1 where id = $2`, [u.tech, agents.tech])
    // Omar (HR not in his scope) has a request from HR Bot assigned to him.
    await db.query(`insert into public.action_requests (agent_id, idempotency_key, request_hash, action, autonomy_level, status, decision_reason, assigned_to, decided_at)
      values ($1, 't1', 'h', 'x', 1, 'approved', 'Approved', $2, now())`, [agents.hr, u.omar])
    await db.query(`update public.profiles set is_active = false where id = $1`, [u.gone])
  })

  const seen = (who: string, sql: string) => asUser(db, who, async (tx) => (await tx.query<{ id: string }>(sql)).rows.map((r) => r.id).sort())

  it('the set equals the per-row rule for admins, executives, auditors, owners, approvers, assignees, nobody and deactivated people', async () => {
    for (const [name, who] of Object.entries(u)) {
      const set = await seen(who, `select public.visible_agent_ids() id`)
      const rule = await asUser(db, who, async (tx) => (await tx.query<{ id: string }>(
        `select x.id from unnest($1::uuid[]) x(id) where public.can_see_agent(x.id)`, [Object.values(agents)])).rows.map((r) => r.id).sort())
      expect(set, name).toEqual(rule)
    }
    expect((await seen(u.ravi, `select public.visible_agent_ids() id`))).toEqual([agents.pay])
    expect((await seen(u.omar, `select public.visible_agent_ids() id`))).toEqual([agents.hr])
    expect((await seen(u.tech, `select public.visible_agent_ids() id`))).toEqual([agents.tech])
    expect(await seen(u.nobody, `select public.visible_agent_ids() id`)).toEqual([])
    expect(await seen(u.gone, `select public.visible_agent_ids() id`)).toEqual([])
  })

  it('the agents list and the requests follow it', async () => {
    expect(await seen(u.ravi, `select id from public.agents`)).toEqual([agents.pay])
    expect((await seen(u.omar, `select agent_id id from public.action_requests`))).toEqual([agents.hr])
    expect(await seen(u.james, `select agent_id id from public.action_requests`)).toEqual([])
    expect((await seen(u.admin, `select id from public.agents`)).length).toBe(3)
  })
})
