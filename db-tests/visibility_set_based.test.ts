import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// 18 Nov: visible_agent_ids() and the agents rule work out the person's facts once per read instead of once per agent
// (the live Approvals list was near its 2-second target). The rule must not change: for every kind of person, the
// agents they see are exactly those can_see_agent (the per-agent check) allows.
describe('who sees which agents, worked out once per read', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  beforeAll(async () => {
    db = await createDb()
    const pay = await createDepartment(db, 'Payments')
    const ops = await createDepartment(db, 'Operations')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')            // approver for Payments
    u.daniel = await createUser(db, 'daniel@bank.test', ['approver'], 'Daniel Okafor')     // approver for nothing, but assigned a request
    u.exapprover = await createUser(db, 'ex@bank.test', ['owner'], 'Ex Approver')          // has a scope but no longer the approver role
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.tom = await createUser(db, 'tom@bank.test', ['owner'], 'Tom Becker')
    u.auditor = await createUser(db, 'auditor@bank.test', ['auditor'], 'Mei Lin')
    u.gone = await createUser(db, 'gone@bank.test', ['auditor'], 'Gone Away')
    await grantScope(db, u.ravi, pay)
    await db.query(`insert into public.approver_scopes (user_id, department_id) values ($1, $2)`, [u.exapprover, pay])
    const a1 = await proposeAgent(db, u.james, { name: 'Pay 1', department_id: pay })
    await proposeAgent(db, u.james, { name: 'Pay 2', department_id: pay })
    const o1 = await proposeAgent(db, u.tom, { name: 'Ops 1', department_id: ops })
    await proposeAgent(db, u.tom, { name: 'No dept', department_id: null })
    await db.query(`update public.agents set technical_owner_id = $2 where id = $1`, [o1, u.james])
    const { rows } = await db.query<{ id: string }>(`insert into public.action_requests (agent_id, idempotency_key, request_hash, action, autonomy_level, status, decision_reason)
      values ($1, 'k', 'k', 'Pay', 1, 'pending', 'Needs a person') returning id`, [o1])
    await db.query(`update public.action_requests set assigned_to = $2 where id = $1`, [rows[0].id, u.daniel])
    await db.query(`update public.profiles set is_active = false where id = $1`, [u.gone])
    void a1
  })

  const sets = (who: string) => asUser(db, who, async (tx) => {
    const ids = async (sql: string) => (await tx.query<{ id: string }>(sql)).rows.map((r) => r.id).sort()
    return {
      fast: await ids(`select v id from public.visible_agent_ids() v`),
      perAgent: await ids(`select id from public.agents_all_for_test() id where public.can_see_agent(id)`),
      table: await ids(`select id from public.agents`),
      names: (await tx.query<{ name: string }>(`select name from public.agents order by name`)).rows.map((r) => r.name),
    }
  })

  it('every kind of person sees exactly the agents the per-agent check allows', async () => {
    await db.query(`create function public.agents_all_for_test() returns setof uuid language sql security definer set search_path = '' as $$ select id from public.agents $$`)
    await db.query(`grant execute on function public.agents_all_for_test() to authenticated`)
    const want: Record<string, string[]> = {
      ravi: ['Pay 1', 'Pay 2'], daniel: ['Ops 1'], exapprover: [], james: ['Ops 1', 'Pay 1', 'Pay 2'],
      tom: ['No dept', 'Ops 1'], auditor: ['No dept', 'Ops 1', 'Pay 1', 'Pay 2'], gone: [],
    }
    for (const [who, names] of Object.entries(want)) {
      const s = await sets(u[who])
      expect(s.fast, who).toEqual(s.perAgent)
      expect(s.table, who).toEqual(s.perAgent)
      expect(s.names, who).toEqual(names)
    }
  })
})
