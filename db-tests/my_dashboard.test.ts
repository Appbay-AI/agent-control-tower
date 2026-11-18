import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 6.5: the operational dashboard ("My work"). Done when: each user sees only their own. Four people with
// different work; each must see exactly theirs and nothing of anyone else's.
describe('my dashboard (task 6.5)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  const ag: Record<string, string> = {}
  type Mine = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const mine = (who: string) => asUser(db, who, async (tx) => (await tx.query<{ d: Mine }>(`select public.my_dashboard() d`)).rows[0].d)
  const sys = async (sql: string, params: unknown[]) => {
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(sql, params)
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
  }
  // Routing and the SLA timers set the assignee and deadline on insert, so they are set straight after, as a person would.
  const request = async (agent: string, key: string, assigned: string | null, due: string) => {
    const { rows } = await db.query<{ id: string }>(`insert into public.action_requests (agent_id, idempotency_key, request_hash, action, autonomy_level, status, decision_reason)
              values ($1, $2, $2, 'Release payment ' || $2, 2, 'pending', 'Needs a person') returning id`, [agent, key])
    await db.query(`update public.action_requests set assigned_to = $2 where id = $1`, [rows[0].id, assigned])
    await db.query(`update public.action_requests set due_at = now() + $2::interval where id = $1`, [rows[0].id, due])
  }
  const incident = (agent: string, owner: string, due: string, title: string) =>
    db.query(`insert into public.incidents (agent_id, source, severity, status, title, reporter, owner_id, sla_minutes, due_at)
              values ($1, 'agent_report', 'high', 'open', $3, 'The agent', $2, 60, now() + $4::interval) returning id`, [agent, owner, title, due])

  beforeAll(async () => {
    db = await createDb()
    const pay = await createDepartment(db, 'Payments')
    const ops = await createDepartment(db, 'Operations')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.daniel = await createUser(db, 'daniel@bank.test', ['approver'], 'Daniel Okafor')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.tom = await createUser(db, 'tom@bank.test', ['owner'], 'Tom Becker')
    await grantScope(db, u.ravi, pay)
    await grantScope(db, u.daniel, pay)

    // James owns the Live Payments agent A (review overdue); Tom owns Operations agent B; James proposes C for approval.
    ag.a = await proposeAgent(db, u.james, { name: 'Payment Release Assistant', department_id: pay })
    await sys(`update public.agents set status = 'approved' where id = $1`, [ag.a])
    await sys(`update public.agents set status = 'live', next_review_date = current_date - 5 where id = $1`, [ag.a])
    ag.b = await proposeAgent(db, u.tom, { name: 'Mail Room Router', department_id: ops })
    ag.c = await proposeAgent(db, u.james, { name: 'Invoice Matcher', department_id: pay })
    await asUser(db, u.james, (tx) => tx.query(`select public.submit_agent_for_approval($1)`, [ag.c]))

    // Requests on A: one assigned to Ravi and overdue, one for any Payments approver.
    await request(ag.a, 'r1', u.ravi, '-10 minutes')
    await request(ag.a, 'r2', null, '1 hour')
    // Incidents: one on A owned by James, overdue; one on B owned by Ravi (on someone else's agent), overdue.
    await incident(ag.a, u.james, '-1 hour', 'Paid twice')
    const ib = (await incident(ag.b, u.ravi, '-2 hours', 'Letters lost')).rows[0] as { id: string }
    // A closure on B's incident named to Daniel.
    await db.query(`update public.incidents set closure_approver_id = $2, closure_requested_by = $3, closure_requested_at = now() where id = $1`, [ib.id, u.daniel, u.ravi])
  })

  it('Ravi: both Payments requests (one overdue), the registration, and the incident he owns on Tom\'s agent', async () => {
    const d = await mine(u.ravi)
    expect(d.me).toBe('Ravi Menon')
    expect(d.approvals.requests.map((r: Mine) => [r.action, r.assigned])).toEqual([['Release payment r1', true], ['Release payment r2', false]])
    expect(d.approvals.registrations.map((r: Mine) => r.agent)).toEqual([expect.stringContaining('Invoice Matcher')])
    expect(d.approvals.closures).toEqual([])
    expect(d.agents).toEqual([])
    expect(d.breaches.map((b: Mine) => [b.kind, b.title])).toEqual([
      ['incident', expect.stringContaining('Letters lost')], ['request', expect.stringContaining('Release payment r1')]])
  })

  it('Daniel: only the unassigned request, the registration and the closure named to him', async () => {
    const d = await mine(u.daniel)
    expect(d.approvals.requests.map((r: Mine) => r.action)).toEqual(['Release payment r2'])
    expect(d.approvals.registrations).toHaveLength(1)
    expect(d.approvals.closures.map((c: Mine) => c.title)).toEqual(['Letters lost'])
    expect(d.agents).toEqual([])
    expect(d.breaches).toEqual([])
  })

  it('James: his agents and their overdue incident and review, nothing to decide on his own agents', async () => {
    const d = await mine(u.james)
    expect(d.approvals).toEqual({ requests: [], registrations: [], reactivations: [], closures: [] })
    expect(d.agents.map((a: Mine) => [a.name, a.role, a.review_overdue, a.open_incidents, a.pending_requests])).toEqual([
      ['Payment Release Assistant', 'Business owner', true, 1, 2], ['Invoice Matcher', 'Business owner', false, 0, 0]])
    expect(d.breaches.map((b: Mine) => b.kind).sort()).toEqual(['incident', 'review'])
    expect(JSON.stringify(d)).not.toContain('Letters lost') // Tom's agent's incident, owned by Ravi
  })

  it('Tom: his agent and its incident (owned by Ravi), nothing of James\'s', async () => {
    const d = await mine(u.tom)
    expect(d.agents.map((a: Mine) => [a.name, a.open_incidents])).toEqual([['Mail Room Router', 1]])
    expect(d.breaches.map((b: Mine) => [b.kind, b.owner])).toEqual([['incident', false]])
    expect(JSON.stringify(d)).not.toMatch(/Payment Release Assistant|Invoice Matcher|Paid twice/)
  })

  it('needs a signed-in, active person', async () => {
    await expect(db.query(`select public.my_dashboard()`)).rejects.toThrow(/Sign in to see your work/)
    await db.query(`update public.profiles set is_active = false where id = $1`, [u.tom])
    await expect(mine(u.tom)).rejects.toThrow(/Sign in to see your work/)
    await db.query(`update public.profiles set is_active = true where id = $1`, [u.tom])
  })
})
