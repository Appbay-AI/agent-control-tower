import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 6.1 (R5.5): the evidence pack. Done when: the PDF holds inventory, approvals, incidents, autonomy changes,
// reviews, kill-switch events, drift, sync history and an attestation. This checks the data behind the PDF.
describe('evidence pack (task 6.1)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let agent: string
  let code: string
  let conn: string
  const today = new Date().toISOString().slice(0, 10)
  const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

  type Pack = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const pack = (who: string, from = days(-30), to = today, agentId: string | null = null) =>
    asUser(db, who, async (tx) => (await tx.query<{ p: Pack }>(`select public.evidence_pack($1::date, $2::date, $3::uuid) p`, [from, to, agentId])).rows[0].p)

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.auditor = await createUser(db, 'auditor@bank.test', ['auditor'], 'Grace Auditor')
    u.exec = await createUser(db, 'exec@bank.test', ['executive'], 'Eve Executive')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    await grantScope(db, u.ravi, payments)
    await db.query(`select public.platform_configure('appian_simulator', 'Northbridge Agent Platform (simulated)', 'https://appbay-demo.appiancloud.com', 'appian-key')`)
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id

    // An agent registered, its autonomy raised, approved, reviewed, made Live, suspended (which opens an incident).
    agent = await proposeAgent(db, u.james, { name: 'Payment Release Assistant', department_id: payments })
    code = (await db.query<{ c: string }>(`select agent_code c from public.agents where id = $1`, [agent])).rows[0].c
    await asUser(db, u.james, (tx) => tx.query(`update public.agents set autonomy_level = 2 where id = $1`, [agent]))
    const reg = await asUser(db, u.james, async (tx) => (await tx.query<{ id: string }>(`select public.submit_agent_for_approval($1) id`, [agent])).rows[0].id)
    await asUser(db, u.ravi, (tx) => tx.query(`select public.decide_registration($1, 'approve', 'Limits are right')`, [reg]))
    await asUser(db, u.ravi, (tx) => tx.query(`select public.record_review($1, 'no_change', 'Quarterly check')`, [agent]))
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'live' where id = $1`, [agent])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    await asUser(db, u.admin, (tx) => tx.query(`select public.suspend_agent($1, 'Released a payment twice')`, [agent]))

    // A request a person approved, and one that timed out.
    await db.query(`insert into public.action_requests (agent_id, idempotency_key, request_hash, action, amount, currency, autonomy_level,
                      status, decision_source, decision_reason, decided_by, decided_at)
                    values ($1, 'k1', 'h1', 'Release payment', 2000000, 'GBP', 2, 'approved', 'human', 'Approved by Ravi Menon', $2, now()),
                           ($1, 'k2', 'h2', 'Release payment', 10, 'GBP', 2, 'expired', 'timeout', 'Nobody decided in time', null, now())`, [agent, u.ravi])

    // Drift, a re-quarantine, and sync history (one quiet sync, one that found an agent, one that failed).
    await db.query(`insert into public.drift_events (agent_id, kind, expected, observed, action, result)
                    values ($1, 'switched_on_outside', 'Blocked', 'Active', 'Blocked again', 'Read back as blocked')`, [agent])
    await db.query(`insert into public.agent_enforcements (agent_id, action, cause, method, target, status, attempts, detail, finished_at)
                    values ($1, 'stop', 'reblock', 'platform', 'Northbridge Agent Platform (simulated) as NAP-001', 'done', 1, 'Blocked; read back as blocked', now())`, [agent])
    await db.query(`insert into public.platform_jobs (connection_id, kind, token_hash, ok, message, result, finished_at) values
                    ($1, 'sync', 'a', true, 'Synced 8 agents: no changes', '{"new":0,"agents":8}', now()),
                    ($1, 'sync', 'b', true, 'Synced 9 agents: 1 new', '{"new":1,"agents":9}', now()),
                    ($1, 'sync', 'c', false, 'Appian did not answer', null, now()),
                    ($1, 'reconcile', 'd', true, 'Checked 1 suspended agent: no change', '{"checked":1,"reblocked":0}', now())`, [conn])
  })

  it('holds every section the auditor asked for', async () => {
    const p = await pack(u.auditor)
    expect(p.period).toEqual({ from: days(-30), to: today, timezone: 'UTC' })
    expect(p.generated).toMatchObject({ by: 'Grace Auditor', roles: ['auditor'] })

    expect(p.inventory.rows).toEqual([expect.objectContaining({ code, name: 'Payment Release Assistant', department: 'Payments',
      business_owner: 'James Whitfield', status: 'suspended', autonomy_level: 2, source: 'Manual' })])
    expect(p.registrations.rows).toEqual([expect.objectContaining({ outcome: 'approved',
      decisions: [expect.objectContaining({ by: 'Ravi Menon', decision: 'approve', reason: 'Limits are right' })] })])
    expect(p.requests).toMatchObject({ total: 1, expired: 1, refused: 0 })
    expect(p.requests.rows[0]).toMatchObject({ action: 'Release payment', outcome: 'approved', decided_by: 'Ravi Menon' })
    expect(p.incidents.rows).toEqual([expect.objectContaining({ source: 'suspension', status: 'open' })])
    expect(p.autonomy.rows).toEqual([expect.objectContaining({ from: 1, to: 2, by: 'James Whitfield' })])
    expect(p.reviews.rows).toEqual([expect.objectContaining({ by: 'Ravi Menon', outcome: 'no_change', notes: 'Quarterly check' })])
    expect(p.suspensions.rows).toEqual([expect.objectContaining({ status: 'done', reason: 'Released a payment twice', requested_by: 'Platform Admin' })])
    expect(p.drift.rows).toEqual([expect.objectContaining({ kind: 'switched_on_outside', observed: 'Active' })])
    expect(p.requarantine.rows).toEqual([expect.objectContaining({ status: 'done', detail: 'Blocked; read back as blocked' })])
    expect(p.enforcement.rows.every((e: { cause: string }) => e.cause !== 'reblock')).toBe(true)

    // Sync history: counts for every run; listed only the failure and the sync that found something.
    expect(p.sync.platforms).toEqual([expect.objectContaining({ name: 'Northbridge Agent Platform (simulated)', syncs: 3, failed: 1, reconciliations: 1 })])
    expect(p.sync.rows.map((r: { message: string }) => r.message)).toEqual(['Synced 9 agents: 1 new', 'Appian did not answer'])
  })

  it('attests: the audit chain is checked, the period bounded, the pack digested and itself recorded', async () => {
    const p = await pack(u.auditor)
    const a = p.attestation
    expect(a).toMatchObject({ chain_intact: true, chain_broken_at: null })
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(a.period_events).toBeGreaterThan(5)
    expect(a.period_first.seq).toBeLessThan(a.period_last.seq)
    const ev = (await db.query<{ action: string; actor_id: string; after: { digest: string } }>(
      `select action, actor_id, after from public.audit_events where seq = $1`, [a.pack_seq])).rows[0]
    expect(ev).toMatchObject({ action: 'evidence_pack.generated', actor_id: u.auditor, after: { digest: a.digest } })
    // The chain still verifies after the pack's own entry.
    expect((await db.query(`select * from public.audit_verify_chain()`)).rows).toEqual([])
  })

  it('keeps to the period: a range before anything happened is empty, apart from the inventory as it stands', async () => {
    const p = await pack(u.admin, days(-60), days(-40))
    expect(p.inventory.total).toBe(0) // registered after the period ended
    for (const k of ['registrations', 'requests', 'incidents', 'autonomy', 'reviews', 'suspensions', 'drift', 'requarantine', 'enforcement']) {
      expect(p[k].total, k).toBe(0)
    }
    expect(p.sync.total).toBe(0)
  })

  it('admins, executives and auditors only; sensible ranges only', async () => {
    await expect(pack(u.exec)).resolves.toBeTruthy()
    await expect(pack(u.james)).rejects.toThrow(/Only admins, executives and auditors/)
    await expect(pack(u.ravi)).rejects.toThrow(/Only admins, executives and auditors/)
    await expect(pack(u.auditor, today, days(-1))).rejects.toThrow(/start date on or before the end date/)
    await expect(pack(u.auditor, days(-400), today)).rejects.toThrow(/at most a year/)
  })

  // 20 Nov: the pack for one agent holds only that agent's records, says which agent it is, and the audit entry says so.
  it('for one agent: only that agent, everywhere', async () => {
    const other = await proposeAgent(db, u.james, { name: 'FX Router', department_id: payments })
    const reg = await asUser(db, u.james, async (tx) => (await tx.query<{ id: string }>(`select public.submit_agent_for_approval($1) id`, [other])).rows[0].id)
    await asUser(db, u.ravi, (tx) => tx.query(`select public.decide_registration($1, 'approve', 'FX limits fine')`, [reg]))
    await asUser(db, u.ravi, (tx) => tx.query(`select public.record_review($1, 'no_change', 'FX check')`, [other]))
    await db.query(`insert into public.platform_agents (connection_id, external_id, name, status, details, agent_id)
                    values ($1, 'NAP-009', 'Payment Release Assistant', 'blocked', '{}', $2)`, [conn, agent])

    const all = await pack(u.auditor)
    expect(all.agent).toBeNull()
    expect(all.inventory.total).toBe(2)
    expect(all.reviews.total).toBe(2)

    const one = await pack(u.auditor, days(-30), today, agent)
    expect(one.agent).toEqual({ id: agent, code, name: 'Payment Release Assistant' })
    expect(one.inventory.rows.map((r: { code: string }) => r.code)).toEqual([code])
    expect(one.reviews.rows).toEqual([expect.objectContaining({ notes: 'Quarterly check' })])
    expect(one.requests).toMatchObject({ total: 1, expired: 1 })
    expect(one.incidents.total).toBe(1)
    expect(one.sync.platforms).toEqual([expect.objectContaining({ name: 'Northbridge Agent Platform (simulated)', syncs: 3 })])
    expect(one.sync.total).toBe(2)
    expect(one.attestation.period_events).toBeLessThan(all.attestation.period_events)
    const ev = (await db.query<{ summary: string; after: { agent_code: string } }>(
      `select summary, after from public.audit_events where seq = $1`, [one.attestation.pack_seq])).rows[0]
    expect(ev.summary).toContain(`for ${code} Payment Release Assistant`)
    expect(ev.after.agent_code).toBe(code)

    const fx = await pack(u.auditor, days(-30), today, other)
    expect(fx.inventory.rows).toEqual([expect.objectContaining({ name: 'FX Router' })])
    expect(fx.reviews.rows).toEqual([expect.objectContaining({ notes: 'FX check' })])
    expect(fx.registrations.rows).toEqual([expect.objectContaining({ reason: 'FX limits fine' })])
    for (const k of ['requests', 'incidents', 'autonomy', 'suspensions', 'drift', 'requarantine', 'enforcement']) {
      expect(fx[k].total, k).toBe(0)
    }
    expect(fx.requests).toMatchObject({ expired: 0, refused: 0 })
    expect(fx.sync).toMatchObject({ platforms: [], total: 0, rows: [] })

    await expect(pack(u.auditor, days(-30), today, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/Agent not found/)
  })
})
