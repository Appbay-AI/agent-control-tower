import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 6.3 (R5.3): the executive dashboard's figures, worked out in the database in one call.
describe('executive dashboard (task 6.3)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  type Dash = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const dash = (who: string) => asUser(db, who, async (tx) => (await tx.query<{ d: Dash }>(`select public.executive_dashboard() d`)).rows[0].d)
  const lifecycle = async (id: string, ...statuses: string[]) => {
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    for (const s of statuses) await db.query(`update public.agents set status = $2 where id = $1`, [id, s])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
  }

  const sys = async (sql: string, id: string) => {
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(sql, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
  }

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.exec = await createUser(db, 'exec@bank.test', ['executive'], 'Priya Sharma')
    u.auditor = await createUser(db, 'auditor@bank.test', ['auditor'], 'Mei Lin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    await grantScope(db, u.ravi, payments)
    await db.query(`select public.platform_configure('appian_simulator', 'Northbridge Agent Platform (simulated)', 'https://appbay-demo.appiancloud.com', 'appian-key')`)
    const conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id

    // Live critical agent by hand, its review overdue; a high-risk agent through the API, approved, whose owner left;
    // an agent found on Appian waiting for approval; a retired agent (left out); one more Appian agent not linked.
    const live = await proposeAgent(db, u.james, { name: 'Payment Release Assistant', department_id: payments })
    await db.query(`update public.agents set risk_tier = 'critical' where id = $1`, [live])
    await lifecycle(live, 'approved', 'live')
    await sys(`update public.agents set next_review_date = current_date - 3 where id = $1`, live)
    const api = await proposeAgent(db, u.james, { name: 'Invoice Matcher', department_id: payments })
    await db.query(`update public.agents set risk_tier = 'high', registration_source = 'api' where id = $1`, [api])
    await lifecycle(api, 'approved')
    await sys(`update public.agents set business_owner_id = null where id = $1`, api)
    const found = await proposeAgent(db, u.james, { name: 'Treasury Cash Forecaster', department_id: payments })
    await db.query(`update public.agents set registration_source = 'discovered' where id = $1`, [found])
    await db.query(`insert into public.platform_agents (connection_id, external_id, name, status, details, agent_id) values
                    ($1, 'NAP-006', 'Treasury Cash Forecaster', 'active', '{}'::jsonb, $2), ($1, 'NAP-009', 'Unlinked', 'active', '{}'::jsonb, null)`, [conn, found])
    const old = await proposeAgent(db, u.james, { name: 'Old Agent', department_id: payments })
    await lifecycle(old, 'retired')

    // A request decided by a person 90 minutes after it was asked; one waiting; an open and a contained incident.
    await db.query(`insert into public.action_requests (agent_id, idempotency_key, request_hash, action, autonomy_level, status, decision_source,
                      decision_reason, requested_at, decided_at)
                    values ($1, 'k1', 'h1', 'Release payment', 2, 'approved', 'human', 'ok', now() - interval '100 minutes', now() - interval '10 minutes'),
                           ($1, 'k2', 'h2', 'Release payment', 2, 'pending', null, 'Waiting', now() - interval '5 minutes', null)`, [live])
    await db.query(`insert into public.incidents (agent_id, source, severity, status, title, reporter, sla_minutes, due_at) values
                    ($1, 'agent_report', 'high', 'open', 'Paid twice', 'The agent', 1440, now() - interval '1 hour'),
                    ($1, 'agent_report', 'low', 'contained', 'Slow', 'The agent', 10080, now() + interval '1 day'),
                    ($1, 'agent_report', 'medium', 'closed', 'Old', 'The agent', 4320, now())`, [live])
  })

  it('gives every figure the executive asked for', async () => {
    const d = await dash(u.exec)
    expect(d.agents).toBe(3)
    expect(d.by_status).toEqual({ proposed: 1, approved: 1, live: 1, suspended: 0 })
    expect(d.by_tier).toEqual([{ tier: 'low', agents: 0, live: 0 }, { tier: 'medium', agents: 1, live: 0 },
      { tier: 'high', agents: 1, live: 0 }, { tier: 'critical', agents: 1, live: 1 }])
    expect(d.by_source).toEqual({ platform: 1, api: 1, manual: 1 })
    expect(d.coverage).toEqual({ listed: 2, governed: 0, awaiting: 1, retired: 0, unlinked: 1 })
    expect(d.no_owner).toMatchObject({ count: 1, agents: [expect.objectContaining({ name: 'Invoice Matcher' })] })
    expect(d.overdue_reviews).toMatchObject({ count: 1, agents: [expect.objectContaining({ name: 'Payment Release Assistant' })] })
    expect(d.incidents).toEqual({ open: 1, contained: 1, overdue: 1, by_severity: { low: 1, medium: 0, high: 1, critical: 0 } })
    expect(d.pending).toMatchObject({ registrations: 0, requests: 1, reactivations: 0, closures: 0 })
    expect(d.pending.oldest).toBeTruthy()
    expect(d.approval_time.requests).toMatchObject({ decided: 1, avg_minutes: 90, median_minutes: 90 })
    expect(d.approval_time_by_week).toHaveLength(8)
    expect(d.approval_time_by_week.at(-1)).toMatchObject({ decided: 1, avg_minutes: 90 })
    expect(d.incidents_by_week).toHaveLength(8)
    expect(d.incidents_by_week.at(-1)).toMatchObject({ low: 1, medium: 1, high: 1, critical: 0 })
  })

  it('a change shows at once: approving the found agent makes Appian coverage 1 of 2', async () => {
    const found = (await db.query<{ id: string }>(`select id from public.agents where name = 'Treasury Cash Forecaster'`)).rows[0].id
    await lifecycle(found, 'approved')
    expect((await dash(u.auditor)).coverage).toMatchObject({ listed: 2, governed: 1, awaiting: 0 })
  })

  it('admins, executives and auditors only', async () => {
    await expect(dash(u.admin)).resolves.toBeTruthy()
    await expect(dash(u.james)).rejects.toThrow(/Only admins, executives and auditors/)
    await expect(dash(u.ravi)).rejects.toThrow(/Only admins, executives and auditors/)
  })
})
