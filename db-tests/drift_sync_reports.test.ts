import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, proposeAgent } from './harness'

// Task 6.6 (R5.1, R5.2): the drift report and sync health. Done when: the reports match the records. A known set of
// drift events and sync runs, inside and outside the period; the reports must give exactly these.
describe('drift report and sync health (task 6.6)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let conn: string
  let agent: string
  let other: string
  type R = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const drift = (who: string, from = day(-30), to = day(0)) =>
    asUser(db, who, async (tx) => (await tx.query<{ r: R }>(`select public.drift_report($1::date, $2::date) r`, [from, to])).rows[0].r)
  const health = (who: string, days = 14) =>
    asUser(db, who, async (tx) => (await tx.query<{ r: R }>(`select public.sync_health($1) r`, [days])).rows[0].r)
  const job = (kind: string, ok: boolean | null, ago: string, result: object | null, message: string) =>
    db.query(`insert into public.platform_jobs (connection_id, kind, token_hash, ok, message, result, created_at, finished_at)
              values ($1, $2, md5(random()::text), $3::boolean, $4, $5::jsonb, now() - $6::interval, case when $3::boolean is null then null else now() - $6::interval end)`,
      [conn, kind, ok, message, result, ago])

  beforeAll(async () => {
    db = await createDb()
    const pay = await createDepartment(db, 'Payments')
    u.auditor = await createUser(db, 'auditor@bank.test', ['auditor'], 'Mei Lin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    await db.query(`select public.platform_configure('appian_simulator', 'Northbridge Agent Platform (simulated)', 'https://appbay-demo.appiancloud.com', 'k')`)
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id
    agent = await proposeAgent(db, u.james, { name: 'Payment Release Assistant', department_id: pay })
    other = await proposeAgent(db, u.james, { name: 'Mail Room Router', department_id: pay })
    const pa = (await db.query<{ id: string }>(`insert into public.platform_agents (connection_id, external_id, name, status, details, agent_id, first_seen_at)
      values ($1, 'NAP-001', 'Payment Release Assistant', 'active', '{}', $2, now() - interval '40 days') returning id`, [conn, agent])).rows[0].id
    await db.query(`insert into public.platform_agents (connection_id, external_id, name, status, details, first_seen_at) values
      ($1, 'NAP-009', 'New one', 'active', '{}', now() - interval '2 days'),
      ($1, 'NAP-010', 'Gone', 'active', '{}', now() - interval '40 days')`, [conn])
    await db.query(`update public.platform_agents set missing_since = now() - interval '1 day' where external_id = 'NAP-010'`)

    // Drift: two on the payment agent (one by a named person, with an incident), one on the other agent 60 days ago.
    const inc = (await db.query<{ id: string }>(`insert into public.incidents (agent_id, source, severity, status, title, reporter, sla_minutes, due_at)
      values ($1, 'agent_report', 'high', 'open', 'Switched on outside', 'Control Tower', 60, now()) returning id`, [agent])).rows[0].id
    await db.query(`insert into public.drift_events (agent_id, platform_agent_id, kind, expected, observed, actor, action, result, incident_id, detected_at) values
      ($1, $2, 'switched_on_outside', 'Blocked', 'Active', 'appian.admin', 'Blocked again', 'Read back as blocked', $3, now() - interval '2 days'),
      ($1, $2, 'owner_changed', 'James Whitfield', 'Someone Else', 'Unknown, outside Control Tower', 'Recorded', 'Owner asked to confirm', null, now() - interval '1 day'),
      ($4, null, 'sharing_changed', 'Payments', 'Everyone', 'Unknown, outside Control Tower', 'Recorded', 'Recorded', null, now() - interval '60 days')`,
      [agent, pa, inc, other])

    // Sync runs: 20 days ago (outside 14 days) with 3 new; within: an OK quiet run, a run finding 1 new and 1 status change,
    // a failure, then two more failures (failing now: 2 after the last OK), and a reconciliation that re-blocked one.
    await job('sync', true, '20 days', { new: 3, agents: 7 }, 'Synced 7 agents: 3 new')
    await job('sync', true, '3 days', { new: 0, agents: 8 }, 'Synced 8 agents: no changes')
    await job('sync', true, '2 days', { new: 1, status_changed: 1, agents: 9 }, 'Synced 9 agents: 1 new, 1 status change')
    await job('sync', false, '30 hours', null, 'Appian did not answer')
    await job('sync', true, '20 hours', { new: 0, missing: 1, agents: 8 }, 'Synced 8 agents: 1 missing')
    await job('sync', false, '2 hours', null, 'Appian did not answer')
    await job('sync', false, '1 hour', null, 'Appian refused the key')
    await job('reconcile', true, '5 hours', { checked: 1, reblocked: 1 }, 'Blocked 1 agent again')
  })

  it('drift report: every change in the period, newest first, with who, what, action, result and incident', async () => {
    const r = await drift(u.auditor)
    expect(r.total).toBe(2)
    expect(r.rows.map((x: R) => [x.kind, x.actor, x.expected, x.observed, x.action, x.result])).toEqual([
      ['owner_changed', 'Unknown, outside Control Tower', 'James Whitfield', 'Someone Else', 'Recorded', 'Owner asked to confirm'],
      ['switched_on_outside', 'appian.admin', 'Blocked', 'Active', 'Blocked again', 'Read back as blocked']])
    expect(r.rows[1]).toMatchObject({ platform: 'Northbridge Agent Platform (simulated)', external_id: 'NAP-001', department: 'Payments',
      incident: expect.stringMatching(/^INC-/), agent: expect.stringContaining('Payment Release Assistant') })
    expect(r.by_kind).toEqual({ owner_changed: 1, switched_on_outside: 1 })
    expect(r.by_actor).toEqual([{ actor: 'Unknown, outside Control Tower', changes: 1 }, { actor: 'appian.admin', changes: 1 }])
    expect(r.by_agent).toEqual([expect.objectContaining({ agent_id: agent, changes: 2 })])
    // A wider period takes in the change 60 days ago.
    expect((await drift(u.auditor, day(-90), day(0))).total).toBe(3)
  })

  it('sync health: last good fetch, failures in a row, counts in 24 hours and in the period, agents, day by day', async () => {
    const h = await health(u.auditor)
    expect(h.platforms).toHaveLength(1)
    const p = h.platforms[0]
    expect(p.last_ok.message).toBe('Synced 8 agents: 1 missing')
    expect(p.last_failure.message).toBe('Appian refused the key')
    expect(p.failing_now).toBe(2)
    expect(p.day).toEqual({ syncs: 3, failed: 2 })
    expect(p.period).toEqual({ syncs: 6, failed: 3, not_finished: 0, new: 1, back: 0, missing: 1, status_changed: 1, linked: 0, registered: 0 })
    expect(p.reconciliations).toEqual({ checks: 1, failed: 0, reblocked: 1 })
    expect(p.agents).toEqual({ listed: 2, missing: 1, linked: 1, first_seen: 1 })
    expect(p.by_day).toHaveLength(14)
    const sum = (k: string) => p.by_day.reduce((n: number, d: R) => n + d[k], 0)
    expect([sum('syncs'), sum('failed'), sum('changes')]).toEqual([6, 3, 3])
    // Listed: the failures and the fetches that found something (not the quiet one), and the re-block.
    expect(h.notable.map((n: R) => n.message)).toEqual(['Appian refused the key', 'Appian did not answer', 'Blocked 1 agent again',
      'Synced 8 agents: 1 missing', 'Appian did not answer', 'Synced 9 agents: 1 new, 1 status change'])
    expect((await health(u.auditor, 30)).platforms[0].period.new).toBe(4)
  })

  it('admins, executives and auditors only; sensible ranges', async () => {
    await expect(drift(u.james)).rejects.toThrow(/Only admins, executives and auditors/)
    await expect(health(u.james)).rejects.toThrow(/Only admins, executives and auditors/)
    await expect(drift(u.auditor, day(0), day(-1))).rejects.toThrow(/start date on or before/)
    await expect(health(u.auditor, 0)).rejects.toThrow(/between 1 and 90 days/)
  })
})
