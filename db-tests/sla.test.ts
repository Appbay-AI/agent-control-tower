import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 2.9: time limits. Overdue requests are escalated once (if the rule says so) or expire (default, fail closed).
describe('time limits (task 2.9)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.owner = await createUser(db, 'owner@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.daniel = await createUser(db, 'daniel@bank.test', ['approver'], 'Daniel Okafor')
    u.olly = await createUser(db, 'olly@bank.test', ['approver', 'owner'], 'Olly Owner')
    u.gone = await createUser(db, 'gone@bank.test', ['approver'], 'Gina Gone')
    for (const p of [u.ravi, u.daniel]) await grantScope(db, p, payments)
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
  })

  beforeEach(async () => {
    // Decided requests keep their rule; detach before removing rules.
    await db.query(`update public.action_requests set status = 'cancelled', decided_at = now() where status = 'pending'`)
    await db.query(`update public.routing_rules set is_active = false`)
    await db.query(`update public.sla_settings set minutes = case urgency when 'critical' then 30 when 'high' then 120 when 'normal' then 480 else 1440 end`)
  })

  const rule = (fields: Record<string, unknown>) => asUser(db, u.admin, async (tx) => {
    const v = { name: 'Large payments', priority: 10, min_amount: 1000000, currency: 'GBP', approver_id: u.ravi, ...fields }
    const cols = Object.keys(v)
    return (await tx.query<{ id: string }>(`insert into public.routing_rules (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, Object.values(v))).rows[0].id
  })

  async function liveAgent(owner = u.owner) {
    const id = await proposeAgent(db, owner, { name: `Agent ${crypto.randomUUID().slice(0, 6)}`, department_id: payments, autonomy_level: 3,
      value_threshold: 250000, threshold_currency: 'GBP' })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    return asUser(db, owner, async (tx) => (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
  }

  const ask = async (key: string, urgency = 'normal', amount = 2_000_000) => asRole(db, 'anon', async (tx) =>
    (await tx.query<{ r: { request_id: string; status: string } }>(`select public.api_request_action($1, $2::jsonb) r`, [key, JSON.stringify({
      idempotency_key: crypto.randomUUID(), action: 'payment.release', amount, currency: 'GBP', urgency,
      description: 'Release £2,000,000 to supplier Hartwell Steel Ltd', callback_url: 'https://agent.example.com/cb',
    })])).rows[0].r)

  type Row = { status: string; assigned_to: string | null; minutes_left: number | null; sla_minutes: number; sla_escalate_to: string | null;
    decision_source: string | null; decision_reason: string | null; escalation_reason: string | null; escalated_by: string | null; routing_note: string }
  const row = async (id: string) => (await db.query<Row>(`select status, assigned_to, round(extract(epoch from due_at - now()) / 60)::int minutes_left,
      sla_minutes, sla_escalate_to, decision_source, decision_reason, escalation_reason, escalated_by, routing_note
      from public.action_requests where id = $1`, [id])).rows[0]
  const overdue = (id: string) => db.query(`update public.action_requests set due_at = now() - interval '1 second' where id = $1`, [id])
  const sweep = async () => (await db.query<{ n: number }>(`select public.sla_sweep() n`)).rows[0].n

  it('a waiting request gets the default limit for its urgency', async () => {
    const key = await liveAgent()
    expect(await row((await ask(key, 'normal')).request_id)).toMatchObject({ sla_minutes: 480, minutes_left: 480, sla_escalate_to: null })
    expect(await row((await ask(key, 'critical')).request_id)).toMatchObject({ sla_minutes: 30, minutes_left: 30 })
    expect(await row((await ask(key, 'low')).request_id)).toMatchObject({ sla_minutes: 1440 })
  })

  it('a rule\'s own limit wins over the default, and admins can change the defaults', async () => {
    await rule({ sla_minutes: 45 })
    const key = await liveAgent()
    expect(await row((await ask(key)).request_id)).toMatchObject({ assigned_to: u.ravi, sla_minutes: 45 })
    await asUser(db, u.admin, (tx) => tx.query(`update public.sla_settings set minutes = 60 where urgency = 'normal'`))
    await db.query(`update public.routing_rules set is_active = false`)
    expect((await row((await ask(key)).request_id)).sla_minutes).toBe(60)
    // Only admins change them (others' updates touch nothing), and every change is audited.
    await asUser(db, u.ravi, (tx) => tx.query(`update public.sla_settings set minutes = 1 where urgency = 'normal'`))
    expect((await db.query<{ m: number }>(`select minutes m from public.sla_settings where urgency = 'normal'`)).rows[0].m).toBe(60)
    const audit = await db.query(`select 1 from public.audit_events where action = 'sla_settings.update'`)
    expect(audit.rows.length).toBeGreaterThan(0)
  })

  it('overdue with no one to escalate to: it expires, the agent is told no, and it is audited as the system', async () => {
    const key = await liveAgent()
    const { request_id: id } = await ask(key)
    expect(await sweep()).toBe(0) // not due yet
    await overdue(id)
    expect(await sweep()).toBe(1)
    expect(await row(id)).toMatchObject({ status: 'expired', decision_source: 'timeout',
      decision_reason: 'No decision within 8 hours, so it was not allowed. The agent must not proceed.' })
    const agentView = await db.query<{ j: { status: string; may_proceed: boolean } }>(
      `select public.action_request_json(r, false) j from public.action_requests r where id = $1`, [id])
    expect(agentView.rows[0].j).toMatchObject({ status: 'expired', may_proceed: false })
    expect((await db.query(`select 1 from public.callback_outbox where request_id = $1`, [id])).rows).toHaveLength(1)
    const audit = await db.query<{ actor_type: string; reason: string }>(
      `select actor_type, reason from public.audit_events where entity_id = $1 and action = 'action_requests.update' order by seq desc limit 1`, [id])
    expect(audit.rows[0]).toEqual({ actor_type: 'system', reason: 'No decision within 8 hours: expired' })
  })

  it('overdue with an escalation rule: it moves once to the next approver, with a fresh limit and an alert; then expires', async () => {
    await rule({ sla_minutes: 30, on_overdue: 'escalate', overdue_escalate_to: u.daniel })
    const key = await liveAgent()
    const { request_id: id } = await ask(key)
    expect(await row(id)).toMatchObject({ assigned_to: u.ravi, sla_escalate_to: u.daniel })
    await db.query(`delete from public.push_outbox`)
    await overdue(id)
    await sweep()
    expect(await row(id)).toMatchObject({ status: 'pending', assigned_to: u.daniel, minutes_left: 30, sla_escalate_to: null, escalated_by: null,
      escalation_reason: 'No decision within 30 minutes, so it was escalated automatically',
      routing_note: 'No decision within 30 minutes: escalated automatically to Daniel Okafor' })
    const alerts = await db.query<{ user_id: string; title: string }>(`select user_id, title from public.push_outbox where request_id = $1`, [id])
    expect(alerts.rows).toEqual([{ user_id: u.daniel, title: expect.stringMatching(/^Escalated to you · REQ-/) }])

    await overdue(id)
    await sweep()
    expect((await row(id)).status).toBe('expired')
  })

  it('expires instead of escalating to someone who cannot decide (inactive, or owns the agent)', async () => {
    await rule({ on_overdue: 'escalate', overdue_escalate_to: u.olly })
    const key = await liveAgent(u.olly) // Olly owns this agent
    const { request_id: id } = await ask(key)
    await overdue(id)
    await sweep()
    expect((await row(id)).status).toBe('expired')

    await db.query(`update public.routing_rules set is_active = false`)
    await rule({ on_overdue: 'escalate', overdue_escalate_to: u.daniel })
    const key2 = await liveAgent()
    const second = await ask(key2)
    await db.query(`update public.profiles set is_active = false where id = $1`, [u.daniel])
    await overdue(second.request_id)
    await sweep()
    await db.query(`update public.profiles set is_active = true where id = $1`, [u.daniel])
    expect((await row(second.request_id)).status).toBe('expired')
  })

  it('a person escalating it gives the new approver a fresh limit; a decision stops the clock', async () => {
    const key = await liveAgent()
    const { request_id: id } = await ask(key, 'critical')
    await db.query(`update public.action_requests set due_at = now() + interval '1 minute' where id = $1`, [id])
    await asUser(db, u.ravi, (tx) => tx.query(`select public.escalate_action_request($1, $2, 'Needs the risk lead')`, [id, u.daniel]))
    expect(await row(id)).toMatchObject({ assigned_to: u.daniel, minutes_left: 30 })

    const done = await ask(key)
    await asUser(db, u.daniel, (tx) => tx.query(`select public.decide_action_request($1, 'approve', null)`, [done.request_id]))
    await overdue(done.request_id).catch(() => undefined) // decided requests cannot be changed at all
    await sweep()
    expect((await row(done.request_id)).status).toBe('approved')
  })

  it('requests that were waiting before time limits existed never expire', async () => {
    const key = await liveAgent()
    const { request_id: id } = await ask(key)
    await db.query(`update public.action_requests set due_at = null where id = $1`, [id])
    await sweep()
    expect((await row(id)).status).toBe('pending')
    // Moving it to someone else does not start a clock either.
    await asUser(db, u.ravi, (tx) => tx.query(`select public.escalate_action_request($1, $2, 'Over to you')`, [id, u.daniel]))
    expect((await row(id)).minutes_left).toBeNull()
  })

  it('rules check the escalate-to person', async () => {
    await expect(rule({ on_overdue: 'escalate' })).rejects.toThrow(/Choose who it goes to when nobody decides in time/)
    await expect(rule({ on_overdue: 'escalate', overdue_escalate_to: u.ravi })).rejects.toThrow(/someone other than the rule's approver/)
    await expect(rule({ on_overdue: 'escalate', overdue_escalate_to: u.owner })).rejects.toThrow(/active user with the Approver role/)
    await expect(rule({ sla_minutes: 0 })).rejects.toThrow()
    const id = await rule({ on_overdue: 'reject', overdue_escalate_to: u.daniel })
    expect((await db.query<{ t: string | null }>(`select overdue_escalate_to t from public.routing_rules where id = $1`, [id])).rows[0].t).toBeNull()
  })

  it('a rule can be deleted after it routed requests that were decided (fix for task 2.3); the decision stays locked', async () => {
    const ruleId = await rule({})
    const key = await liveAgent()
    const { request_id: id } = await ask(key)
    await asUser(db, u.ravi, (tx) => tx.query(`select public.decide_action_request($1, 'approve', 'ok')`, [id]))
    await asUser(db, u.admin, (tx) => tx.query(`delete from public.routing_rules where id = $1`, [ruleId]))
    const r = (await db.query<{ routing_rule_id: string | null; status: string }>(`select routing_rule_id, status from public.action_requests where id = $1`, [id])).rows[0]
    expect(r).toEqual({ routing_rule_id: null, status: 'approved' })
    await expect(db.query(`update public.action_requests set decision_reason = 'changed' where id = $1`, [id])).rejects.toThrow(/already decided/)
    await expect(db.query(`update public.action_requests set routing_rule_id = null, decision_reason = 'sneaky' where id = $1`, [id])).rejects.toThrow(/already decided/)
  })

  it('says limits in plain words', async () => {
    const t = async (m: number) => (await db.query<{ t: string }>(`select public.minutes_text($1) t`, [m])).rows[0].t
    expect([await t(1), await t(30), await t(60), await t(120), await t(90), await t(1440), await t(2880)])
      .toEqual(['1 minute', '30 minutes', '1 hour', '2 hours', '90 minutes', '1 day', '2 days'])
  })
})
