import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 2.10: four-eyes approval for Critical agents, and bulk approval for low-risk ones.
describe('four-eyes and bulk approval (task 2.10)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let ops: string

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    ops = await createDepartment(db, 'Operations')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.owner = await createUser(db, 'owner@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.daniel = await createUser(db, 'daniel@bank.test', ['approver'], 'Daniel Okafor')
    u.omar = await createUser(db, 'omar@bank.test', ['approver'], 'Omar Farouk')
    for (const p of [u.ravi, u.daniel]) await grantScope(db, p, payments)
    await grantScope(db, u.omar, ops)
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
    await asUser(db, u.admin, (tx) => tx.query(
      `insert into public.routing_rules (name, priority, min_amount, currency, approver_id) values ('Large payments', 10, 1000000, 'GBP', $1)`, [u.ravi]))
  })

  beforeEach(async () => {
    await db.query(`delete from public.push_outbox`)
  })

  async function liveAgent(risk: 'low' | 'medium' | 'critical', department = payments, autonomy = 3) {
    const id = await proposeAgent(db, u.owner, { name: `Agent ${crypto.randomUUID().slice(0, 6)}`, department_id: department,
      autonomy_level: autonomy, value_threshold: autonomy === 3 ? 250000 : null, threshold_currency: 'GBP', risk_tier: risk })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    return asUser(db, u.owner, async (tx) => (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
  }

  const ask = async (key: string, amount: number | null = 2_000_000) => asRole(db, 'anon', async (tx) =>
    (await tx.query<{ r: { request_id: string; status: string; request_code: string } }>(`select public.api_request_action($1, $2::jsonb) r`, [key, JSON.stringify({
      idempotency_key: crypto.randomUUID(), action: 'payment.release', amount, currency: amount ? 'GBP' : null, description: 'Release £2,000,000 to supplier Hartwell Steel Ltd',
    })])).rows[0].r)

  const decide = (who: string, id: string, d: 'approve' | 'reject', note: string | null = null) =>
    asUser(db, who, async (tx) => (await tx.query<{ s: string }>(`select public.decide_action_request($1, $2, $3) s`, [id, d, note])).rows[0].s)

  type Row = { status: string; required_approvals: number; assigned_to: string | null; decision_reason: string; routing_note: string; decided_by: string | null }
  const row = async (id: string) => (await db.query<Row>(
    `select status, required_approvals, assigned_to, decision_reason, routing_note, decided_by from public.action_requests where id = $1`, [id])).rows[0]

  it('a Critical agent\'s action needs two approvals; other agents need one', async () => {
    expect((await row((await ask(await liveAgent('critical'))).request_id)).required_approvals).toBe(2)
    expect((await row((await ask(await liveAgent('medium'))).request_id)).required_approvals).toBe(1)
  })

  it('the first approval keeps it waiting and opens it to the other approvers; the second decides it', async () => {
    const { request_id: id } = await ask(await liveAgent('critical'))
    expect((await row(id)).assigned_to).toBe(u.ravi)
    await db.query(`delete from public.push_outbox`) // Ravi's first alert

    expect(await decide(u.ravi, id, 'approve', 'Invoice checked')).toBe('pending')
    expect(await row(id)).toMatchObject({ status: 'pending', assigned_to: null,
      decision_reason: 'Approved by Ravi Menon (1 of 2). Waiting for a second approver.',
      routing_note: 'Approved by Ravi Menon (1 of 2): Invoice checked. A second approver must decide.' })
    // The others are alerted; Ravi is not.
    const alerts = await db.query<{ user_id: string; title: string }>(`select user_id, title from public.push_outbox where request_id = $1`, [id])
    expect(alerts.rows).toEqual([{ user_id: u.daniel, title: expect.stringMatching(/^Second approval needed · REQ-/) }])
    const emails = await db.query<{ kind: string }>(`select kind from public.email_outbox where request_id = $1 and user_id = $2`, [id, u.daniel])
    expect(emails.rows.map((e) => e.kind)).toContain('second')
    // The agent still waits.
    const agentView = await db.query<{ j: { status: string; may_proceed: boolean } }>(`select public.action_request_json(r, false) j from public.action_requests r where id = $1`, [id])
    expect(agentView.rows[0].j).toMatchObject({ status: 'pending', may_proceed: false })

    // Ravi cannot approve twice.
    await expect(decide(u.ravi, id, 'approve')).rejects.toThrow(/assigned to someone else/)

    expect(await decide(u.daniel, id, 'approve', 'Supplier verified')).toBe('approved')
    expect(await row(id)).toMatchObject({ status: 'approved', decided_by: u.daniel,
      decision_reason: 'Approved by Ravi Menon (Invoice checked) and Daniel Okafor (Supplier verified)' })
    const audit = await db.query(`select 1 from public.audit_events where action = 'action_request_approvals.insert'`)
    expect(audit.rows.length).toBeGreaterThanOrEqual(2)
  })

  it('one rejection ends it, even after a first approval', async () => {
    const { request_id: id } = await ask(await liveAgent('critical'))
    await decide(u.ravi, id, 'approve')
    expect(await decide(u.daniel, id, 'reject', 'New supplier, not verified')).toBe('rejected')
    expect((await row(id)).decision_reason).toBe('Rejected by Daniel Okafor: New supplier, not verified')
  })

  it('cannot be escalated to, or timed out to, someone who already approved', async () => {
    const { request_id: id } = await ask(await liveAgent('critical'))
    await decide(u.ravi, id, 'approve')
    await expect(asUser(db, u.daniel, (tx) => tx.query(`select public.escalate_action_request($1, $2, 'back to you')`, [id, u.ravi])))
      .rejects.toThrow(/already approved it/)
    const targets = await asUser(db, u.daniel, async (tx) => (await tx.query<{ id: string }>(`select id from public.escalation_targets($1)`, [id])).rows)
    expect(targets.map((t) => t.id)).not.toContain(u.ravi)
    // A time-limit escalation to Ravi is skipped: it expires instead.
    await db.query(`update public.action_requests set sla_escalate_to = $2, due_at = now() - interval '1 second' where id = $1`, [id, u.ravi])
    await db.query(`select public.sla_sweep()`)
    expect((await row(id)).status).toBe('expired')
  })

  it('bulk: approves several low-risk requests at once, each decided and audited on its own', async () => {
    const low = await liveAgent('low', ops, 2)
    const ids = [(await ask(low, null)).request_id, (await ask(low, null)).request_id, (await ask(low, null)).request_id]
    const critical = (await ask(await liveAgent('critical'))).request_id
    const res = await asUser(db, u.omar, async (tx) =>
      (await tx.query<{ r: { id: string; ok: boolean; message: string }[] }>(`select public.decide_action_requests_bulk($1::uuid[], 'Rotas checked') r`, [[...ids, critical]])).rows[0].r)
    expect(res.filter((x) => x.ok).map((x) => x.id)).toEqual(ids)
    expect(res.find((x) => x.id === critical)).toMatchObject({ ok: false, message: 'Not found' }) // Omar cannot see Payments
    for (const id of ids) expect(await row(id)).toMatchObject({ status: 'approved', decided_by: u.omar, decision_reason: 'Approved by Omar Farouk: Bulk approval: Rotas checked' })
    const audit = await db.query<{ n: number }>(`select count(*)::int n from public.audit_events where action = 'action_requests.update' and entity_id = any($1::uuid[])`, [ids])
    expect(audit.rows[0].n).toBe(3)
  })

  it('bulk never approves what is not low-risk or not yours', async () => {
    const medium = (await ask(await liveAgent('medium'))).request_id
    const critical = (await ask(await liveAgent('critical'))).request_id
    const res = await asUser(db, u.ravi, async (tx) =>
      (await tx.query<{ r: { id: string; ok: boolean; message: string }[] }>(`select public.decide_action_requests_bulk($1::uuid[]) r`, [[medium, critical]])).rows[0].r)
    expect(res.map((x) => [x.ok, x.message])).toEqual([[false, 'Not a low-risk request: decide it on its own'], [false, 'Not a low-risk request: decide it on its own']])
    expect((await row(medium)).status).toBe('pending')
    // A low-risk request assigned to someone else is refused with the reason.
    const low = (await ask(await liveAgent('low', ops, 2), null)).request_id
    const other = await asUser(db, u.ravi, async (tx) =>
      (await tx.query<{ r: { ok: boolean; message: string }[] }>(`select public.decide_action_requests_bulk($1::uuid[]) r`, [[low]])).rows[0].r)
    expect(other[0].ok).toBe(false)
    await expect(asUser(db, u.omar, (tx) => tx.query(`select public.decide_action_requests_bulk('{}'::uuid[])`))).rejects.toThrow(/at least one/)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select public.decide_action_requests_bulk('{}'::uuid[])`))).rejects.toThrow(/permission denied/)
  })
})
