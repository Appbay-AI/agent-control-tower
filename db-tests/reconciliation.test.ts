import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, proposeAgent } from './harness'

// Task 4.7: the reconciliation loop. A suspended agent that its platform had confirmed blocked, and that reads active
// again, was switched back on outside Control Tower: blocked again, recorded (actor unknown), Critical incident, admins.
describe('reconciliation loop (task 4.7)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let conn: string
  const PLATFORM = 'Northbridge Agent Platform (simulated)'

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
    await db.query(`select public.platform_configure('appian_simulator', $1, 'https://appbay-demo.appiancloud.com', 'appian-key')`, [PLATFORM])
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id
  })

  const anon = <T>(sql: string, params: unknown[]) => asRole(db, 'anon', async (tx) => (await tx.query<{ r: T }>(sql, params)).rows[0].r)
  const lastToken = async (path: string) => (await db.query<{ token: string }>(
    `select body ->> 'token' token from net.calls where url like $1 order by id desc limit 1`, [`%${path}`])).rows[0]?.token
  const calls = async (path: string) => (await db.query<{ n: number }>(`select count(*)::int n from net.calls where url like $1`, [`%${path}`])).rows[0].n

  /** Report every claimable enforcement step as done (the platform confirmed it). */
  async function confirmEnforcement() {
    await db.query(`update public.agent_enforcements set next_attempt_at = now() - interval '1 second' where status = 'pending'`)
    await db.query(`select public.enforcement_kick()`)
    const t = await lastToken('/enforce/run')
    const work = await anon<{ platform: { id: number }[] }>(`select public.enforcement_claim($1) r`, [t])
    await anon(`select public.enforcement_report($1, $2::jsonb) r`, [t, JSON.stringify(work.platform.map((w) => ({ id: w.id, ok: true, detail: 'Blocked; read back as blocked' })))])
  }

  /** A suspended agent on the platform as `ext`, its block confirmed. */
  async function blockedAgent(ext: string) {
    const id = await proposeAgent(db, u.james, { name: `Agent ${ext}`, department_id: payments, risk_tier: 'high' })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    await db.query(`insert into public.platform_agents (connection_id, external_id, name, status, details, agent_id)
      values ($1, $2, 'Platform agent', 'active', '{}'::jsonb, $3)`, [conn, ext, id])
    await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Paid the wrong supplier')`, [id]))
    await confirmEnforcement()
    return id
  }
  async function reconcile(results: (targets: { platform_agent_id: string; external_id: string }[]) => object[]) {
    const before = await calls('/platforms/run')
    expect(await db.query<{ n: number }>(`select public.platform_reconcile_due() n`).then((r) => r.rows[0].n)).toBe(1)
    expect(await calls('/platforms/run')).toBe(before + 1)
    const t = await lastToken('/platforms/run')
    const job = await anon<{ kind: string; targets: { platform_agent_id: string; external_id: string; agent_code: string }[] }>(`select public.platform_job_claim($1) r`, [t])
    expect(job.kind).toBe('reconcile')
    const out = await anon<{ checked: number; reblocked: number; agents: string[] }>(`select public.platform_reconcile_apply($1, $2::jsonb) r`, [t, JSON.stringify(results(job.targets))])
    await anon(`select public.platform_job_report($1, true, 'Checked', null) r`, [t])
    return { job, out }
  }

  it('nothing suspended on the platform: the clock makes no call at all', async () => {
    const before = await calls('/platforms/run')
    expect((await db.query<{ n: number }>(`select public.platform_reconcile_due() n`)).rows[0].n).toBe(0)
    expect(await calls('/platforms/run')).toBe(before)
  })

  it('still blocked: nothing happens', async () => {
    const id = await blockedAgent('NAP-005')
    const { job, out } = await reconcile((ts) => ts.map((t) => ({ platform_agent_id: t.platform_agent_id, status: 'blocked' })))
    expect(job.targets.map((t) => t.external_id)).toEqual(['NAP-005'])
    expect(out).toEqual({ checked: 1, reblocked: 0, agents: [] })
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.incidents where agent_id = $1 and source = 'reconciliation'`, [id])).rows[0].n).toBe(0)
  })

  it('switched back on outside Control Tower: blocked again, recorded, Critical incident, admins alerted; cleared once confirmed', async () => {
    const id = (await db.query<{ id: string }>(`select agent_id id from public.platform_agents where external_id = 'NAP-005'`)).rows[0].id
    const code = (await db.query<{ c: string }>(`select agent_code c from public.agents where id = $1`, [id])).rows[0].c
    await db.query(`delete from public.push_outbox`)
    const kicks = await calls('/enforce/run')
    const { out } = await reconcile((ts) => ts.map((t) => ({ platform_agent_id: t.platform_agent_id, status: 'active' })))
    expect(out).toEqual({ checked: 1, reblocked: 1, agents: [code] })

    // Blocked again: a new stop step, sent at once.
    const steps = (await db.query<{ cause: string; status: string; target: string }>(
      `select cause, status, target from public.agent_enforcements where agent_id = $1 and action = 'stop' order by id`, [id])).rows
    expect(steps.at(-1)).toEqual({ cause: 'reblock', status: 'pending', target: `${PLATFORM} as NAP-005` })
    expect(await calls('/enforce/run')).toBe(kicks + 1)
    // On the record, actor unknown.
    const audit = (await db.query<{ actor_type: string; actor_id: string | null; summary: string; reason: string }>(
      `select actor_type, actor_id, summary, reason from public.audit_events where action = 'agents.reactivated_outside' and agent_id = $1`, [id])).rows
    expect(audit).toEqual([{ actor_type: 'system', actor_id: null, reason: 'Reconciliation check: actor unknown, outside Control Tower',
      summary: `${code} was switched back on at ${PLATFORM} as NAP-005 outside Control Tower (actor unknown). It is being blocked again.` }])
    // A Critical incident, owned by the agent's business owner.
    const inc = (await db.query<{ severity: string; source: string; title: string; owner_id: string; sla_minutes: number }>(
      `select severity::text, source, title, owner_id, sla_minutes from public.incidents where agent_id = $1 and source = 'reconciliation'`, [id])).rows
    expect(inc).toEqual([{ severity: 'critical', source: 'reconciliation', title: `${code} switched back on outside Control Tower`, owner_id: u.james, sla_minutes: 240 }])
    // An alert, and a phone alert to the admin.
    const alert = (await db.query<{ message: string }>(`select message from public.alerts where agent_id = $1 and kind = 'outside_reactivation' and resolved_at is null`, [id])).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].message).toMatch(/It is being blocked again\. Incident INC-\d{4}\.$/)
    const pushes = (await db.query<{ user_id: string; title: string }>(`select user_id, title from public.push_outbox where kind = 'reconciliation'`)).rows
    expect(pushes).toEqual([{ user_id: u.admin, title: `Switched on outside Control Tower · ${code}` }])
    // The agent is not a target while the re-block is under way.
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.reconcile_targets($1)`, [conn])).rows[0].n).toBe(0)

    // The re-block is confirmed: the alert clears and the agent is checked again next cycle.
    await confirmEnforcement()
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.alerts where agent_id = $1 and kind = 'outside_reactivation' and resolved_at is null`, [id])).rows[0].n).toBe(0)
    expect((await db.query<{ s: string }>(`select status s from public.platform_agents where external_id = 'NAP-005'`)).rows[0].s).toBe('blocked')
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.reconcile_targets($1)`, [conn])).rows[0].n).toBe(1)
  })

  it('switched back on with approval is not an outside switch-on: a Live agent is never a target', async () => {
    const id = await blockedAgent('NAP-006')
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    expect((await db.query<{ e: string }>(`select string_agg(external_id, ',') e from public.reconcile_targets($1)`, [conn])).rows[0].e).toBe('NAP-005')
  })

  it('a block not yet confirmed (still being tried) is left to the retries of task 4.3', async () => {
    const id = await proposeAgent(db, u.james, { name: 'Agent NAP-007', department_id: payments })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    await db.query(`insert into public.platform_agents (connection_id, external_id, name, status, details, agent_id)
      values ($1, 'NAP-007', 'Platform agent', 'active', '{}'::jsonb, $2)`, [conn, id])
    await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Test')`, [id]))
    expect((await db.query<{ e: string }>(`select string_agg(external_id, ',') e from public.reconcile_targets($1)`, [conn])).rows[0].e).toBe('NAP-005')
  })

  it('only our API, with the job token, can report; it is scheduled every 5 minutes', async () => {
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.platform_reconcile_apply('pjt_x', '[]')`))).rejects.toThrow(/permission denied/)
    await expect(anon(`select public.platform_reconcile_apply('pjt_nope', '[]') r`, [])).rejects.toThrow(/Invalid or used job token/)
    const cron = await db.query<{ schedule: string }>(`select schedule from cron.job where jobname = 'platform-reconcile'`).catch(() => ({ rows: [] as { schedule: string }[] }))
    if (cron.rows.length) expect(cron.rows[0].schedule).toBe('*/5 * * * *')
  })
})
