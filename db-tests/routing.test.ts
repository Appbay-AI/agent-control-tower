import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

describe('routing matrix (task 2.3)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let lending: string

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    lending = await createDepartment(db, 'Lending')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'])
    u.owner = await createUser(db, 'owner@bank.test', ['owner'])
    u.deptApprover = await createUser(db, 'payments.approver@bank.test', ['approver'], 'Pat Payments')
    u.bigMoney = await createUser(db, 'big.money@bank.test', ['approver'], 'Bea Bigmoney')
    u.privacy = await createUser(db, 'privacy@bank.test', ['approver'], 'Priv Officer')
    u.approverOwner = await createUser(db, 'approver.owner@bank.test', ['approver', 'owner'], 'Olly Owner')
    await grantScope(db, u.deptApprover, payments)
    await grantScope(db, u.bigMoney, lending) // deliberately outside Payments
    await grantScope(db, u.privacy, lending)
  })

  beforeEach(async () => {
    await db.query(`delete from public.routing_rules`)
  })

  async function liveAgent(owner: string, fields: Record<string, unknown> = {}) {
    const id = await proposeAgent(db, owner, { department_id: payments, autonomy_level: 2, ...fields })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    const key = await asUser(db, owner, async (tx) =>
      (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
    return { id, key }
  }

  const addRule = (fields: Record<string, unknown>) => {
    const values = { name: 'Rule', priority: 100, ...fields }
    const cols = Object.keys(values)
    return asUser(db, u.admin, async (tx) =>
      (await tx.query<{ id: string }>(
        `insert into public.routing_rules (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
        Object.values(values))).rows[0].id)
  }

  const ask = async (key: string, amount: number | null = 100) => {
    const r = await asRole(db, 'anon', async (tx) =>
      (await tx.query<{ r: { request_id: string } }>(`select public.api_request_action($1, $2::jsonb) r`, [key, JSON.stringify({
        idempotency_key: crypto.randomUUID(), action: 'payment.release', ...(amount === null ? {} : { amount, currency: 'GBP' }),
      })])).rows[0].r)
    return (await db.query<{ assigned_to: string | null; routing_note: string; routing_rule_id: string | null }>(
      `select assigned_to, routing_note, routing_rule_id from public.action_requests where id = $1`, [r.request_id])).rows[0]
  }

  it('with no rules, a waiting request goes to the department approvers', async () => {
    const { key } = await liveAgent(u.owner)
    const r = await ask(key)
    expect(r.assigned_to).toBeNull()
    expect(r.routing_note).toMatch(/No rule matched: any approver for Payments may decide/)
  })

  it('a value band routes large amounts to a named approver; the band includes its lower edge only', async () => {
    const rule = await addRule({ name: 'Large payments', department_id: payments, min_amount: 1_000_000, currency: 'GBP', approver_id: u.bigMoney })
    const { key } = await liveAgent(u.owner)
    expect((await ask(key, 999_999.99)).assigned_to).toBeNull()
    const big = await ask(key, 1_000_000)
    expect(big).toMatchObject({ assigned_to: u.bigMoney, routing_rule_id: rule })
    expect(big.routing_note).toMatch(/Rule "Large payments" assigned it to Bea Bigmoney/)
    expect((await ask(key, null)).assigned_to).toBeNull() // no amount, so a value band cannot match
  })

  it('rules are checked in priority order and inactive rules are ignored', async () => {
    await addRule({ name: 'Second', priority: 20, approver_id: u.privacy })
    await addRule({ name: 'First but off', priority: 10, approver_id: u.bigMoney, is_active: false })
    const { key } = await liveAgent(u.owner)
    expect((await ask(key)).assigned_to).toBe(u.privacy)
  })

  it('matches on data the agent touches and on minimum risk tier', async () => {
    await addRule({ name: 'Personal data', priority: 10, data_classification: 'personal', approver_id: u.privacy })
    await addRule({ name: 'High risk', priority: 20, min_risk_tier: 'high', approver_id: u.bigMoney })
    const personal = await liveAgent(u.owner, { data_classifications: '{personal}' })
    const critical = await liveAgent(u.owner, { risk_tier: 'critical' })
    const plain = await liveAgent(u.owner, { risk_tier: 'medium' })
    expect((await ask(personal.key)).assigned_to).toBe(u.privacy)
    expect((await ask(critical.key)).assigned_to).toBe(u.bigMoney)
    expect((await ask(plain.key)).assigned_to).toBeNull()
  })

  it('never assigns the agent\'s own owner; it skips that rule and says so', async () => {
    await addRule({ name: 'To Olly', priority: 10, approver_id: u.approverOwner })
    await addRule({ name: 'To Priv', priority: 20, approver_id: u.privacy })
    const { key } = await liveAgent(u.approverOwner)
    const r = await ask(key)
    expect(r.assigned_to).toBe(u.privacy)
    expect(r.routing_note).toMatch(/rule "To Olly" skipped: Olly Owner owns or created this agent/)
  })

  it('a deactivated approver is skipped at routing time', async () => {
    const leaver = await createUser(db, 'leaver.approver@bank.test', ['approver'], 'Lee Leaver')
    await addRule({ name: 'To Lee', priority: 10, approver_id: leaver })
    await db.query(`update public.profiles set is_active = false where id = $1`, [leaver])
    const { key } = await liveAgent(u.owner)
    const r = await ask(key)
    expect(r.assigned_to).toBeNull()
    expect(r.routing_note).toMatch(/Lee Leaver is not an active approver/)
  })

  it('only admins change rules, the approver must hold the Approver role, and changes are audited', async () => {
    await expect(asUser(db, u.deptApprover, (tx) => tx.query(
      `insert into public.routing_rules (name, approver_id) values ('x', $1)`, [u.deptApprover]))).rejects.toThrow(/row-level security/)
    await expect(addRule({ approver_id: u.owner })).rejects.toThrow(/must be an active user with the Approver role/)
    await expect(addRule({ min_amount: 10, approver_id: u.bigMoney })).rejects.toThrow(/band_needs_currency/)
    const id = await addRule({ name: 'Audited', approver_id: u.bigMoney })
    const audit = await db.query<{ action: string }>(`select action from public.audit_events where entity_id = $1`, [id])
    expect(audit.rows.map((r) => r.action)).toEqual(['routing_rules.insert'])
  })

  it('the assigned approver can see the request and its agent, even outside their department', async () => {
    await addRule({ name: 'Large payments', min_amount: 1_000_000, currency: 'GBP', approver_id: u.bigMoney })
    const { id, key } = await liveAgent(u.owner)
    await ask(key, 2_000_000)
    const seen = await asUser(db, u.bigMoney, async (tx) => ({
      agents: (await tx.query(`select 1 from public.agents where id = $1`, [id])).rows.length,
      requests: (await tx.query(`select 1 from public.action_requests where agent_id = $1`, [id])).rows.length,
    }))
    expect(seen).toEqual({ agents: 1, requests: 1 })
  })

  it('re-routing applies changed rules to requests that are still waiting', async () => {
    const { key } = await liveAgent(u.owner)
    const before = await ask(key)
    expect(before.assigned_to).toBeNull()
    await addRule({ name: 'Now to Priv', approver_id: u.privacy })
    const n = await asUser(db, u.admin, async (tx) => (await tx.query<{ n: number }>(`select public.reroute_pending_requests() n`)).rows[0].n)
    expect(n).toBeGreaterThan(0)
    const left = await db.query(`select 1 from public.action_requests where status = 'pending' and assigned_to is distinct from $1`, [u.privacy])
    expect(left.rows).toHaveLength(0)
    await expect(asUser(db, u.deptApprover, (tx) => tx.query(`select public.reroute_pending_requests()`))).rejects.toThrow(/Only admins/)
  })

  it('preview shows which rule and approver a request would get', async () => {
    await addRule({ name: 'Large payments', min_amount: 1_000_000, currency: 'GBP', approver_id: u.bigMoney })
    const { id } = await liveAgent(u.owner)
    const p = await asUser(db, u.admin, async (tx) =>
      (await tx.query<{ p: Record<string, unknown> }>(`select public.preview_routing($1, 2000000, 'gbp') p`, [id])).rows[0].p)
    expect(p).toMatchObject({ rule_name: 'Large payments', approver_name: 'Bea Bigmoney', department_approvers: ['Pat Payments'] })
  })
})
