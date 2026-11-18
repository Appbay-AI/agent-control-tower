import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, proposeAgent } from './harness'

// Task 6.4: the risk dashboard. Done when: the figures match the data. A known set of agents and breaches, and the
// dashboard must report exactly those counts.
describe('risk dashboard (task 6.4)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  const ag: Record<string, string> = {}
  type Risk = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const risk = (who: string) => asUser(db, who, async (tx) => (await tx.query<{ r: Risk }>(`select public.risk_dashboard() r`)).rows[0].r)
  const sys = async (sql: string, params: unknown[]) => {
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(sql, params)
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
  }
  const incident = (agent: string, severity: string, status: string, ago: string) =>
    db.query(`insert into public.incidents (agent_id, source, severity, status, title, reporter, sla_minutes, due_at, opened_at)
              values ($1, 'agent_report', $2, $3, 'x', 'The agent', 60, now(), now() - $4::interval)`, [agent, severity, status, ago])

  beforeAll(async () => {
    db = await createDb()
    const pay = await createDepartment(db, 'Payments')
    const ops = await createDepartment(db, 'Operations')
    u.exec = await createUser(db, 'exec@bank.test', ['executive'], 'Priya Sharma')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    // Payments: one critical, one high; Operations: two low; one with no department; one retired (left out).
    for (const [k, dept, tier] of [['p1', pay, 'critical'], ['p2', pay, 'high'], ['o1', ops, 'low'], ['o2', ops, 'low'], ['n1', null, 'medium'], ['r1', pay, 'critical']] as const) {
      ag[k] = await proposeAgent(db, u.james, { name: `Agent ${k}`, department_id: dept })
      await sys(`update public.agents set risk_tier = $2 where id = $1`, [ag[k], tier])
    }
    await sys(`update public.agents set status = 'retired' where id = $1`, [ag.r1])

    // Breaches. p1: 3 incidents (1 open critical, 1 contained high, 1 closed low), 2 refusals, 1 drift, 1 access finding.
    // o1: 1 incident 100 days ago (outside the 90 days), 1 refusal 100 days ago. r1 (retired): 1 incident.
    await incident(ag.p1, 'critical', 'open', '1 day')
    await incident(ag.p1, 'high', 'contained', '8 days')
    await incident(ag.p1, 'low', 'closed', '20 days')
    await incident(ag.o1, 'medium', 'closed', '100 days')
    await incident(ag.r1, 'high', 'closed', '2 days')
    for (const [agent, key, ago] of [[ag.p1, 'a', '1 hour'], [ag.p1, 'b', '9 days'], [ag.o1, 'c', '100 days']]) {
      await db.query(`insert into public.action_requests (agent_id, idempotency_key, request_hash, action, autonomy_level, status, decision_source,
                        decision_reason, requested_at, decided_at) values ($1, $2, $2, 'Pay', 1, 'refused', 'policy', 'Over limit', now() - $3::interval, now() - $3::interval)`, [agent, key, ago])
    }
    await db.query(`insert into public.drift_events (agent_id, kind, expected, observed, action, result) values ($1, 'switched_on_outside', 'Blocked', 'Active', 'Blocked again', 'ok')`, [ag.p1])
    await db.query(`insert into public.agent_authority_findings (agent_id, email, name, how, missing) values ($1, 'x@bank.test', 'X', '{direct}', '{personal}')`, [ag.p1])
  })

  it('heat map: active agents by department and tier, with open incidents and breaches', async () => {
    const r = await risk(u.exec)
    expect(r.heat).toEqual([
      { department: 'Operations', low: 2, medium: 0, high: 0, critical: 0, agents: 2, open_incidents: 0, breaches: 0 },
      { department: 'Payments', low: 0, medium: 0, high: 1, critical: 1, agents: 2, open_incidents: 2, breaches: 8 },
      { department: 'No department', low: 0, medium: 1, high: 0, critical: 0, agents: 1, open_incidents: 0, breaches: 0 },
    ])
  })

  it('breach trend and 90-day totals count each kind once, inside the period only', async () => {
    const r = await risk(u.exec)
    // Payments' 8 breaches = 4 incidents (3 of p1 + 1 of retired r1) + 2 refusals + 1 drift + 1 access.
    expect(r.totals).toEqual({ refused: 2, incident: 4, drift: 1, access: 1 })
    expect(r.trend).toHaveLength(12)
    const sum = (k: string) => r.trend.reduce((n: number, w: Record<string, number>) => n + w[k], 0)
    expect([sum('refused'), sum('incident'), sum('drift'), sum('access')]).toEqual([2, 4, 1, 1])
    expect(r.trend.at(-1)).toMatchObject({ drift: 1, access: 1 })
  })

  it('top agents by incidents in 90 days, most first', async () => {
    const r = await risk(u.exec)
    expect(r.top_agents.map((t: Risk) => [t.name, t.incidents, t.open, t.serious])).toEqual([['Agent p1', 3, 2, 2], ['Agent r1', 1, 0, 1]])
    expect(r.top_agents[0]).toMatchObject({ department: 'Payments', risk_tier: 'critical', status: 'proposed' })
  })

  it('admins, executives and auditors only', async () => {
    await expect(risk(u.james)).rejects.toThrow(/Only admins, executives and auditors/)
  })
})
