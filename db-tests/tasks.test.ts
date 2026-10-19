import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

describe('approver task: approve, reject, escalate (task 2.4)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    const lending = await createDepartment(db, 'Lending')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'])
    u.owner = await createUser(db, 'owner@bank.test', ['owner'], 'Owen Owner')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.daniel = await createUser(db, 'daniel@bank.test', ['approver'], 'Daniel Okafor')
    u.outsider = await createUser(db, 'outsider@bank.test', ['approver'], 'Olu Outsider')
    u.approverOwner = await createUser(db, 'approver.owner@bank.test', ['approver', 'owner'], 'Olly Owner')
    await grantScope(db, u.ravi, payments)
    await grantScope(db, u.daniel, payments)
    await grantScope(db, u.approverOwner, payments)
    await grantScope(db, u.outsider, lending)
    // Large payments go to Ravi, as in the demo.
    await asUser(db, u.admin, (tx) => tx.query(
      `insert into public.routing_rules (name, priority, min_amount, currency, approver_id) values ('Large payments', 10, 1000000, 'GBP', $1)`,
      [u.ravi]))
  })

  async function liveAgent(owner = u.owner) {
    const id = await proposeAgent(db, owner, { department_id: payments, autonomy_level: 3, value_threshold: 250000, threshold_currency: 'GBP' })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    const key = await asUser(db, owner, async (tx) =>
      (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
    return { id, key }
  }

  /** The agent asks for a payment; returns the request id. */
  const ask = async (key: string, amount: number) =>
    asRole(db, 'anon', async (tx) =>
      (await tx.query<{ r: { request_id: string; status: string } }>(`select public.api_request_action($1, $2::jsonb) r`, [key, JSON.stringify({
        idempotency_key: crypto.randomUUID(), action: 'payment.release', amount, currency: 'GBP',
        description: 'Release payment to Acme Steel', reasoning: 'Invoice INV-2291 is due today',
      })])).rows[0].r)

  const decide = (who: string, id: string, decision: string, reason: string | null = null) =>
    asUser(db, who, async (tx) =>
      (await tx.query<{ s: string }>(`select public.decide_action_request($1, $2, $3) s`, [id, decision, reason])).rows[0].s)

  const escalate = (who: string, id: string, to: string, reason: string | null) =>
    asUser(db, who, (tx) => tx.query(`select public.escalate_action_request($1, $2, $3)`, [id, to, reason]))

  const row = async (id: string) => (await db.query<Record<string, unknown>>(`select * from public.action_requests where id = $1`, [id])).rows[0]

  /** What the agent itself hears back. */
  const agentView = (key: string, id: string) =>
    asRole(db, 'anon', async (tx) =>
      (await tx.query<{ r: { status: string; may_proceed: boolean; reason: string; decision_source: string } }>(
        `select public.api_action_status($1, $2) r`, [key, id])).rows[0].r)

  it('keeps why the request waited, separately from the decision', async () => {
    const { key } = await liveAgent()
    const r = await ask(key, 2_000_000)
    expect(r.status).toBe('pending')
    expect((await row(r.request_id)).hold_reason).toMatch(/outside its limits/)
  })

  it('the assigned approver approves; the agent may proceed and the decision is audited', async () => {
    const { key } = await liveAgent()
    const { request_id } = await ask(key, 2_000_000)
    expect(await decide(u.ravi, request_id, 'approve', 'Invoice and PO checked')).toBe('approved')
    const r = await row(request_id)
    expect(r).toMatchObject({ status: 'approved', decision_source: 'human', decided_by: u.ravi,
      decision_reason: 'Approved by Ravi Menon: Invoice and PO checked' })
    expect(r.hold_reason).toMatch(/outside its limits/)
    expect(await agentView(key, request_id)).toMatchObject({ status: 'approved', may_proceed: true, decision_source: 'human' })
    const audit = await db.query<{ action: string; actor_id: string; reason: string }>(
      `select action, actor_id, reason from public.audit_events where entity_id = $1 order by seq`, [request_id])
    expect(audit.rows.at(-1)).toMatchObject({ action: 'action_requests.update', actor_id: u.ravi, reason: 'Invoice and PO checked' })
  })

  it('rejecting needs a reason, and the agent is told it', async () => {
    const { key } = await liveAgent()
    const { request_id } = await ask(key, 2_000_000)
    await expect(decide(u.ravi, request_id, 'reject', '  ')).rejects.toThrow(/Say why it is rejected/)
    expect(await decide(u.ravi, request_id, 'reject', 'Beneficiary bank changed last week')).toBe('rejected')
    expect(await agentView(key, request_id)).toMatchObject({
      status: 'rejected', may_proceed: false, reason: 'Rejected by Ravi Menon: Beneficiary bank changed last week',
    })
  })

  it('a decided request cannot be decided again', async () => {
    const { key } = await liveAgent()
    const { request_id } = await ask(key, 2_000_000)
    await decide(u.ravi, request_id, 'approve')
    await expect(decide(u.ravi, request_id, 'reject', 'changed my mind')).rejects.toThrow(/already decided \(approved\)/)
  })

  it('only the assigned approver decides; other approvers, owners and admins cannot', async () => {
    const { key } = await liveAgent(u.approverOwner)
    const { request_id } = await ask(key, 2_000_000)
    await expect(decide(u.daniel, request_id, 'approve')).rejects.toThrow(/assigned to someone else/)
    await expect(decide(u.approverOwner, request_id, 'approve')).rejects.toThrow(/agent you own or created/)
    await expect(decide(u.admin, request_id, 'approve')).rejects.toThrow(/assigned to someone else/)
    await expect(decide(u.outsider, request_id, 'approve')).rejects.toThrow(/doesn't exist, or you don't have access/)
    expect((await row(request_id)).status).toBe('pending')
  })

  it('with no rule, any department approver except the owner decides', async () => {
    const { key } = await liveAgent(u.approverOwner)
    const { request_id } = await ask(key, 300_000) // above the limit, below the large-payments band
    expect((await row(request_id)).assigned_to).toBeNull()
    await expect(decide(u.approverOwner, request_id, 'approve')).rejects.toThrow(/agent you own or created/)
    expect(await decide(u.daniel, request_id, 'approve')).toBe('approved')
  })

  it('an agent suspended since it asked cannot be approved, only rejected', async () => {
    const { id, key } = await liveAgent()
    const { request_id } = await ask(key, 2_000_000)
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'suspended' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    await expect(decide(u.ravi, request_id, 'approve')).rejects.toThrow(/is now suspended, so this action cannot be approved/)
    expect(await decide(u.ravi, request_id, 'reject', 'Agent suspended')).toBe('rejected')
  })

  it('escalation needs a reason and an eligible approver, and hands the task over', async () => {
    const { id, key } = await liveAgent(u.approverOwner)
    const { request_id } = await ask(key, 2_000_000)
    await expect(escalate(u.ravi, request_id, u.daniel, '')).rejects.toThrow(/Say why you are escalating/)
    await expect(escalate(u.ravi, request_id, u.ravi, 'me')).rejects.toThrow(/someone other than yourself/)
    await expect(escalate(u.ravi, request_id, u.owner, 'x')).rejects.toThrow(/active user with the Approver role/)
    await expect(escalate(u.ravi, request_id, u.approverOwner, 'x')).rejects.toThrow(/owns or created this agent/)
    await expect(escalate(u.daniel, request_id, u.outsider, 'x')).rejects.toThrow(/assigned to someone else/)

    const targets = await asUser(db, u.ravi, async (tx) =>
      (await tx.query<{ full_name: string }>(`select full_name from public.escalation_targets($1)`, [request_id])).rows.map((r) => r.full_name))
    expect(targets).toEqual(['Daniel Okafor', 'Olu Outsider'])

    await escalate(u.ravi, request_id, u.outsider, 'Needs a second view from Lending')
    const r = await row(request_id)
    expect(r).toMatchObject({ assigned_to: u.outsider, escalated_by: u.ravi, escalation_reason: 'Needs a second view from Lending',
      routing_note: 'Escalated by Ravi Menon to Olu Outsider: Needs a second view from Lending', status: 'pending' })
    // The new approver now sees it and decides; the previous one no longer can.
    const seen = await asUser(db, u.outsider, async (tx) => (await tx.query(`select 1 from public.agents where id = $1`, [id])).rows.length)
    expect(seen).toBe(1)
    await expect(decide(u.ravi, request_id, 'approve')).rejects.toThrow()
    expect(await decide(u.outsider, request_id, 'approve')).toBe('approved')
  })

  it('re-applying routing rules leaves escalated requests where they were sent', async () => {
    const { key } = await liveAgent()
    const { request_id } = await ask(key, 2_000_000)
    await escalate(u.ravi, request_id, u.daniel, 'Ravi is on leave')
    await asUser(db, u.admin, (tx) => tx.query(`select public.reroute_pending_requests()`))
    expect((await row(request_id)).assigned_to).toBe(u.daniel)
  })

  it('nobody can change a request directly; only through these functions', async () => {
    const { key } = await liveAgent()
    const { request_id } = await ask(key, 2_000_000)
    await expect(asUser(db, u.ravi, (tx) => tx.query(`update public.action_requests set status = 'approved' where id = $1`, [request_id])))
      .rejects.toThrow(/permission denied/)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select public.decide_action_request($1, 'approve', null)`, [request_id])))
      .rejects.toThrow(/permission denied/)
  })
})
