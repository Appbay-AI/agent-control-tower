import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 4.4: an incident opens by itself when an agent is suspended, and agents or connected systems can report one.
// Every incident has an owner and a time by which it should be resolved.
describe('incident case (task 4.4)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let integrationKey: string

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.tech = await createUser(db, 'tech@bank.test', ['owner'], 'Tara Tech')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.omar = await createUser(db, 'omar@bank.test', ['approver'], 'Omar Farouk')
    u.audit = await createUser(db, 'audit@bank.test', ['auditor'], 'Aud Itor')
    u.other = await createUser(db, 'other@bank.test', ['owner'], 'Someone Else')
    await grantScope(db, u.ravi, payments)
    integrationKey = await asUser(db, u.admin, async (tx) => (await tx.query<{ k: string }>(`select public.create_integration_key('ServiceNow') k`)).rows[0].k)
  })

  async function liveAgent(opts: { risk?: string; tech?: string | null; noOwner?: boolean } = {}) {
    const id = await proposeAgent(db, u.james, { name: `Agent ${crypto.randomUUID().slice(0, 6)}`, department_id: payments,
      risk_tier: opts.risk ?? 'high', technical_owner_id: opts.tech ?? null })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    if (opts.noOwner) await db.query(`update public.agents set business_owner_id = null where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    const key = await asUser(db, u.james, async (tx) => (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
    const code = (await db.query<{ c: string }>(`select agent_code c from public.agents where id = $1`, [id])).rows[0].c
    return { id, key, code }
  }
  type Inc = { incident_code: string; source: string; severity: string; status: string; title: string; description: string | null
    reporter: string; owner_id: string | null; owner_reason: string | null; sla_minutes: number; due_in: number; suspension_id: string | null }
  const incidents = async (agent: string) => (await db.query<Inc>(
    `select incident_code, source, severity::text, status, title, description, reporter, owner_id, owner_reason, sla_minutes,
            round(extract(epoch from due_at - opened_at) / 60)::int due_in, suspension_id
       from public.incidents where agent_id = $1 order by opened_at, incident_code`, [agent])).rows
  const report = (key: string, payload: Record<string, unknown>) => asRole(db, 'anon', async (tx) =>
    (await tx.query<{ r: Record<string, unknown> }>(`select public.api_report_incident($1, $2::jsonb) r`, [key, JSON.stringify(payload)])).rows[0].r)
  const pushes = async (user: string) => (await db.query<{ title: string; body: string; url: string }>(
    `select title, body, url from public.push_outbox where user_id = $1 and kind = 'incident' order by id`, [user])).rows

  it('suspending an agent opens an incident owned by its business owner, due by its severity; the owner is told', async () => {
    const { id, code } = await liveAgent({ risk: 'high' })
    await asUser(db, u.ravi, (tx) => tx.query(`select public.suspend_agent($1, 'Paying the wrong supplier')`, [id]))
    const [i] = await incidents(id)
    expect(i).toMatchObject({ incident_code: expect.stringMatching(/^INC-\d{4}$/), source: 'suspension', severity: 'high', status: 'open',
      title: `${code} suspended: Paying the wrong supplier`, description: 'Paying the wrong supplier',
      reporter: 'Ravi Menon (suspended it)', owner_id: u.james, owner_reason: 'Business owner of the agent', sla_minutes: 1440, due_in: 1440 })
    expect(i.suspension_id).not.toBeNull()
    const [p] = await pushes(u.james)
    expect(p.title).toBe(`Incident ${i.incident_code} · ${code}`)
    expect(p.body).toMatch(/^AGT-\d{4} suspended: Paying the wrong supplier\. High severity; resolve by \d\d \w{3} \d\d:\d\d UTC\. You own it\.$/)
    expect(p.url).toBe(`/agents/${id}`)
    // On the record.
    const audit = (await db.query<{ n: number }>(`select count(*)::int n from public.audit_events where entity_type = 'incidents' and action = 'incidents.insert' and agent_id = $1`, [id])).rows[0].n
    expect(audit).toBe(1)
  })

  it('codes count up and the time limit follows the severity; admins can change it', async () => {
    const crit = await liveAgent({ risk: 'critical' })
    await asUser(db, u.admin, (tx) => tx.query(`select public.suspend_agent($1, 'Data leak')`, [crit.id]))
    expect((await incidents(crit.id))[0]).toMatchObject({ severity: 'critical', sla_minutes: 240, due_in: 240 })

    await asUser(db, u.admin, (tx) => tx.query(`update public.incident_sla set minutes = 60 where severity = 'low'`))
    await expect(asUser(db, u.james, (tx) => tx.query(`update public.incident_sla set minutes = 15 where severity = 'low'`)))
      .resolves.toMatchObject({ affectedRows: 0 }) // not an admin: nothing changes
    expect((await db.query<{ m: number }>(`select minutes m from public.incident_sla where severity = 'low'`)).rows[0].m).toBe(60)
    const low = await liveAgent({ risk: 'low' })
    await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Odd output')`, [low.id]))
    const [a, b] = [(await incidents(crit.id))[0].incident_code, (await incidents(low.id))[0].incident_code]
    expect(Number(b.slice(4))).toBe(Number(a.slice(4)) + 1)
    expect((await incidents(low.id))[0]).toMatchObject({ severity: 'low', sla_minutes: 60 })
  })

  it('no active business owner: the technical owner owns it; neither: whoever suspended it; nobody: an admin', async () => {
    const t = await liveAgent({ tech: u.tech, noOwner: true })
    await asUser(db, u.ravi, (tx) => tx.query(`select public.suspend_agent($1, 'Test')`, [t.id]))
    expect((await incidents(t.id))[0]).toMatchObject({ owner_id: u.tech, owner_reason: 'Technical owner of the agent (it has no active business owner)' })

    const n = await liveAgent({ noOwner: true })
    await asUser(db, u.ravi, (tx) => tx.query(`select public.suspend_agent($1, 'Test')`, [n.id]))
    expect((await incidents(n.id))[0]).toMatchObject({ owner_id: u.ravi, owner_reason: 'Raised it (the agent has no active owner)' })
    expect(await pushes(u.ravi)).toHaveLength(0) // they opened it themselves

    const r = await liveAgent({ noOwner: true })
    await report(r.key, { title: 'Ran out of budget' })
    expect((await incidents(r.id))[0]).toMatchObject({ owner_id: u.admin, owner_reason: 'Admin (the agent has no active owner)' })
  })

  it('an agent reports an incident about itself; a retry with the same key returns the same incident', async () => {
    const { id, key, code } = await liveAgent({ risk: 'medium' })
    const first = await report(key, { title: 'Posted a payment twice', description: 'Invoice INV-77 paid twice.', severity: 'High',
      occurred_at: '2026-11-04T09:15:00Z', details: { invoice: 'INV-77' }, idempotency_key: 'evt-1' })
    expect(first).toMatchObject({ incident_code: expect.stringMatching(/^INC-/), agent_code: code, status: 'open', severity: 'high',
      owner: 'James Whitfield', sla_minutes: 1440, duplicate: false })
    const again = await report(key, { title: 'Posted a payment twice', idempotency_key: 'evt-1' })
    expect(again).toMatchObject({ incident_code: first.incident_code, duplicate: true })
    const rows = await incidents(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'agent_report', reporter: `${code} itself, through the API`, description: 'Invoice INV-77 paid twice.' })
    // The agent stays as it was: reporting does not suspend it (that rule is task 4.9).
    expect((await db.query<{ s: string }>(`select status s from public.agents where id = $1`, [id])).rows[0].s).toBe('live')
    const actor = (await db.query<{ t: string }>(`select actor_type t from public.audit_events where entity_type = 'incidents' and agent_id = $1`, [id])).rows[0].t
    expect(actor).toBe('agent')
  })

  it('a connected system reports about any agent it names; checks its input', async () => {
    const { id, code } = await liveAgent()
    const r = await report(integrationKey, { agent: code.toLowerCase(), title: 'ServiceNow ticket INC0012345 names this agent', severity: 'low' })
    expect(r).toMatchObject({ agent_code: code, severity: 'low', duplicate: false })
    expect((await incidents(id))[0]).toMatchObject({ source: 'integration_report', reporter: 'ServiceNow (integration, through the API)' })
    const actor = (await db.query<{ t: string }>(`select actor_type t from public.audit_events where entity_type = 'incidents' and agent_id = $1`, [id])).rows[0].t
    expect(actor).toBe('integration')

    await expect(report(integrationKey, { title: 'x' })).rejects.toThrow(/Say which agent/)
    await expect(report(integrationKey, { agent: 'AGT-9999', title: 'x' })).rejects.toThrow(/No agent AGT-9999/)
    await expect(report(integrationKey, { agent: code })).rejects.toThrow(/title is required/)
    await expect(report(integrationKey, { agent: code, title: 'x', severity: 'urgent' })).rejects.toThrow(/severity must be/)
    await expect(report(integrationKey, { agent: code, title: 'x', details: [1] })).rejects.toThrow(/details must be a JSON object/)
    await expect(report(integrationKey, { agent: code, title: 'x', occurred_at: 'yesterday' })).rejects.toThrow(/occurred_at must be/)
    await expect(report(integrationKey, { agent: code, title: 'x', occurred_at: '2099-01-01T00:00:00Z' })).rejects.toThrow(/in the future/)
    await expect(report('act_int_nope', { agent: code, title: 'x' })).rejects.toThrow(/Invalid or revoked integration key/)
    await expect(report('act_agt_nope', { title: 'x' })).rejects.toThrow(/Invalid or revoked agent key/)
  })

  it('an agent key cannot report about another agent', async () => {
    const a = await liveAgent()
    const b = await liveAgent()
    await expect(report(a.key, { agent: b.code, title: 'Not mine' })).rejects.toThrow(/different agent/)
  })

  it('who sees an incident: those who see the agent, and its owner; nobody can change one directly', async () => {
    const { id } = await liveAgent()
    await asUser(db, u.ravi, (tx) => tx.query(`select public.suspend_agent($1, 'Visibility test')`, [id]))
    const seen = (who: string) => asUser(db, who, async (tx) =>
      (await tx.query<{ n: number }>(`select count(*)::int n from public.incidents where agent_id = $1`, [id])).rows[0].n)
    expect(await seen(u.james)).toBe(1)  // owner
    expect(await seen(u.ravi)).toBe(1)   // approver for Payments
    expect(await seen(u.audit)).toBe(1)  // auditor sees everything
    expect(await seen(u.admin)).toBe(1)
    expect(await seen(u.omar)).toBe(0)   // approver for another department
    expect(await seen(u.other)).toBe(0)
    await expect(asUser(db, u.admin, (tx) => tx.query(`update public.incidents set status = 'closed' where agent_id = $1`, [id])))
      .rejects.toThrow(/permission denied/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.incident_open($1, 'suspension', 'low', 'x', null, '{}', 'me')`, [id])))
      .rejects.toThrow(/permission denied/)
  })
})
