import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

let db: PGlite
const u: Record<string, string> = {}
let dept: string

beforeEach(async () => {
  db = await createDb()
  dept = await createDepartment(db, 'Payments')
  const other = await createDepartment(db, 'Lending')
  u.owner = await createUser(db, 'owner@bank.test', ['owner'])
  u.approver = await createUser(db, 'approver@bank.test', ['approver'])
  u.approver2 = await createUser(db, 'approver2@bank.test', ['approver'])
  u.outsider = await createUser(db, 'lending.approver@bank.test', ['approver'])
  u.admin = await createUser(db, 'admin@bank.test', ['admin'])
  await grantScope(db, u.approver, dept)
  await grantScope(db, u.approver2, dept)
  await grantScope(db, u.outsider, other)
})

const agentRow = async (id: string) =>
  (await db.query<{ status: string; next_review_date: string | null; approved_by: string | null }>(
    `select status, next_review_date::text, approved_by from public.agents where id = $1`, [id])).rows[0]

const submit = (who: string, agentId: string) =>
  asUser(db, who, async (tx) => (await tx.query<{ id: string }>(`select public.submit_agent_for_approval($1) id`, [agentId])).rows[0].id)

const decide = (who: string, regId: string, decision: string, reason: string | null = null) =>
  asUser(db, who, async (tx) =>
    (await tx.query<{ s: string }>(`select public.decide_registration($1, $2, $3) s`, [regId, decision, reason])).rows[0].s)

describe('registration approval (task 1.5)', () => {
  it('blocks submission without a business owner, a purpose or a department', async () => {
    const noOwner = await proposeAgent(db, u.owner, { business_owner_id: null, department_id: dept })
    await expect(submit(u.owner, noOwner)).rejects.toThrow(/business owner/)
    const noPurpose = await proposeAgent(db, u.owner, { purpose_statement: '  ', department_id: dept })
    await expect(submit(u.owner, noPurpose)).rejects.toThrow(/purpose statement/)
    const noDept = await proposeAgent(db, u.owner)
    await expect(submit(u.owner, noDept)).rejects.toThrow(/department/)
  })

  it('runs Proposed → Approved → Live, sets a 6-month review date, and audits each step', async () => {
    const agent = await proposeAgent(db, u.owner, { department_id: dept })
    const reg = await submit(u.owner, agent)
    expect(await decide(u.approver, reg, 'approve')).toBe('approved')

    const approved = await agentRow(agent)
    expect(approved.status).toBe('approved')
    expect(approved.approved_by).toBe(u.approver)
    const sixMonths = (await db.query<{ d: string }>(`select (current_date + interval '6 months')::date::text d`)).rows[0].d
    expect(approved.next_review_date).toBe(sixMonths)

    await asUser(db, u.owner, (tx) => tx.query(`select public.go_live($1)`, [agent]))
    expect((await agentRow(agent)).status).toBe('live')

    const { rows } = await db.query<{ summary: string }>(
      `select summary from public.audit_events where agent_id = $1 and action = 'agents.status_changed' order by seq`, [agent])
    expect(rows.map((r) => r.summary.split(': ')[1])).toEqual(['proposed → approved', 'approved → live'])
  })

  it('cannot go live without approval', async () => {
    const agent = await proposeAgent(db, u.owner, { department_id: dept })
    await expect(asUser(db, u.owner, (tx) => tx.query(`select public.go_live($1)`, [agent]))).rejects.toThrow(/Only Approved/)
  })

  it('nobody approves their own agent, and approvers outside the department are refused', async () => {
    const approverOwner = await createUser(db, 'approver.owner@bank.test', ['approver', 'owner'])
    await grantScope(db, approverOwner, dept)
    const ownAgent = await proposeAgent(db, approverOwner, { department_id: dept })
    const reg = await submit(approverOwner, ownAgent)
    await expect(decide(approverOwner, reg, 'approve')).rejects.toThrow(/own or submitted/)

    const agent = await proposeAgent(db, u.owner, { department_id: dept })
    const reg2 = await submit(u.owner, agent)
    await expect(decide(u.outsider, reg2, 'approve')).rejects.toThrow(/not an approver for this agent/)
    await expect(decide(u.owner, reg2, 'approve')).rejects.toThrow(/not an approver/)
  })

  it('Critical agents need two different approvers (four-eyes)', async () => {
    const agent = await proposeAgent(db, u.owner, { department_id: dept, risk_tier: 'critical' })
    const reg = await submit(u.owner, agent)
    expect(await decide(u.approver, reg, 'approve')).toBe('pending')
    expect((await agentRow(agent)).status).toBe('proposed')
    await expect(decide(u.approver, reg, 'approve')).rejects.toThrow(/already decided/)
    expect(await decide(u.approver2, reg, 'approve')).toBe('approved')
    expect((await agentRow(agent)).status).toBe('approved')
  })

  it('rejecting or sending back needs a reason; a sent-back agent can be fixed and resubmitted', async () => {
    const agent = await proposeAgent(db, u.owner, { department_id: dept })
    const reg = await submit(u.owner, agent)
    await expect(decide(u.approver, reg, 'send_back')).rejects.toThrow(/reason is required/)
    expect(await decide(u.approver, reg, 'send_back', 'List the systems it touches')).toBe('sent_back')

    await asUser(db, u.owner, (tx) =>
      tx.query(`update public.agents set systems_accessed = '{SAP}' where id = $1`, [agent]))
    const reg2 = await submit(u.owner, agent)
    expect(await decide(u.approver, reg2, 'approve')).toBe('approved')
  })

  it('freezes the agent while it waits for approval and once it is approved', async () => {
    const agent = await proposeAgent(db, u.owner, { department_id: dept })
    const reg = await submit(u.owner, agent)
    await expect(asUser(db, u.owner, (tx) =>
      tx.query(`update public.agents set autonomy_level = 4 where id = $1`, [agent]))).rejects.toThrow(/waiting for approval/)
    await decide(u.approver, reg, 'approve')
    await expect(asUser(db, u.owner, (tx) =>
      tx.query(`update public.agents set autonomy_level = 4 where id = $1`, [agent]))).rejects.toThrow(/Only Proposed agents/)
  })

  it('cannot submit the same agent twice while it is pending', async () => {
    const agent = await proposeAgent(db, u.owner, { department_id: dept })
    await submit(u.owner, agent)
    await expect(submit(u.owner, agent)).rejects.toThrow(/Only Proposed|already waiting/)
  })

  it('retiring an agent withdraws its pending approval', async () => {
    const agent = await proposeAgent(db, u.owner, { department_id: dept })
    const reg = await submit(u.owner, agent)
    await asUser(db, u.owner, (tx) => tx.query(`select public.retire_agent($1, 'No longer needed')`, [agent]))
    const r = await db.query<{ status: string; decision_reason: string }>(
      `select status, decision_reason from public.agent_registrations where id = $1`, [reg])
    expect(r.rows[0]).toEqual({ status: 'rejected', decision_reason: 'Withdrawn: the agent was retired' })
  })

  it("tells the owner who can approve, without revealing anyone else's permissions", async () => {
    const agent = await proposeAgent(db, u.owner, { department_id: dept })
    const names = await asUser(db, u.owner, async (tx) =>
      (await tx.query<{ full_name: string }>(`select full_name from public.approvers_for($1)`, [agent])).rows.map((r) => r.full_name))
    expect(names).toEqual(['approver', 'approver2'])
    // Someone who cannot see the agent learns nothing.
    const hidden = await asUser(db, u.outsider, async (tx) =>
      (await tx.query(`select * from public.approvers_for($1)`, [agent])).rows)
    expect(hidden).toEqual([])
  })

  it('Level 3 agents must have a value or volume limit', async () => {
    await expect(proposeAgent(db, u.owner, { autonomy_level: 3 })).rejects.toThrow(/level3_needs_threshold/)
    await proposeAgent(db, u.owner, { autonomy_level: 3, value_threshold: 10000 })
  })
})

describe('reviews and alerts (task 1.6)', () => {
  const liveAgent = async () => {
    const agent = await proposeAgent(db, u.owner, { department_id: dept })
    await decide(u.approver, await submit(u.owner, agent), 'approve')
    await asUser(db, u.owner, (tx) => tx.query(`select public.go_live($1)`, [agent]))
    return agent
  }
  const openAlerts = async () =>
    (await db.query<{ kind: string; agent_id: string }>(`select kind, agent_id from public.alerts where resolved_at is null`)).rows

  it('flags a live agent whose review is overdue, and clears it when reviewed', async () => {
    const agent = await liveAgent()
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set next_review_date = current_date - 3 where id = $1`, [agent])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)

    expect((await db.query<{ n: number }>(`select public.refresh_alerts() n`)).rows[0].n).toBe(1)
    expect(await openAlerts()).toEqual([{ kind: 'review_overdue', agent_id: agent }])
    // Running again does not duplicate the alert.
    expect((await db.query<{ n: number }>(`select public.refresh_alerts() n`)).rows[0].n).toBe(0)

    await asUser(db, u.owner, (tx) => tx.query(`select public.record_review($1, 'no_change', null)`, [agent]))
    expect(await openAlerts()).toEqual([])
    const r = await agentRow(agent)
    const sixMonths = (await db.query<{ d: string }>(`select (current_date + interval '6 months')::date::text d`)).rows[0].d
    expect(r.next_review_date).toBe(sixMonths)
  })

  it('flags a live agent that has lost its business owner', async () => {
    const agent = await liveAgent()
    await asUser(db, u.admin, (tx) => tx.query(`update public.agents set business_owner_id = null where id = $1`, [agent]))
    await db.query(`select public.refresh_alerts()`)
    expect(await openAlerts()).toEqual([{ kind: 'owner_missing', agent_id: agent }])
  })

  it('only admins may refresh alerts on demand', async () => {
    await expect(asUser(db, u.owner, (tx) => tx.query(`select public.refresh_alerts()`))).rejects.toThrow(/Only admins/)
    await asUser(db, u.admin, (tx) => tx.query(`select public.refresh_alerts()`))
  })

  it('a review that retires the agent needs notes and retires it', async () => {
    const agent = await liveAgent()
    await expect(asUser(db, u.owner, (tx) => tx.query(`select public.record_review($1, 'retire', null)`, [agent])))
      .rejects.toThrow(/Notes are required/)
    await asUser(db, u.owner, (tx) => tx.query(`select public.record_review($1, 'retire', 'Replaced by AGT-0042')`, [agent]))
    expect((await agentRow(agent)).status).toBe('retired')
  })
})

describe('register API and keys (task 1.7)', () => {
  const register = (key: string, payload: object) =>
    asRole(db, 'service_role', async (tx) =>
      (await tx.query<{ r: Record<string, unknown> }>(`select public.api_register_agent($1, $2) r`, [key, JSON.stringify(payload)])).rows[0].r)

  const integrationKey = () =>
    asUser(db, u.admin, async (tx) => (await tx.query<{ k: string }>(`select public.create_integration_key('LangChain platform') k`)).rows[0].k)

  it('registers a complete agent, submits it for approval and returns its own API key once', async () => {
    const key = await integrationKey()
    const res = await register(key, {
      name: 'Invoice matcher', department: 'payments', business_owner_email: 'OWNER@bank.test',
      purpose_statement: 'Match supplier invoices to purchase orders', autonomy_level: 3, value_threshold: 5000,
      framework: 'langchain', data_classifications: ['confidential'], systems_accessed: ['SAP'], risk_tier: 'high',
    })
    expect(res.status).toBe('proposed')
    expect(res.submitted_for_approval).toBe(true)
    expect(String(res.api_key)).toMatch(/^act_agt_[0-9a-f]{64}$/)

    // Only a hash is stored.
    const stored = await db.query<{ key_hash: string }>(`select key_hash from public.agent_api_keys where agent_id = $1`, [res.agent_id])
    expect(stored.rows[0].key_hash).not.toContain(String(res.api_key))

    // The agent may not act until approved and live.
    const status = await asRole(db, 'service_role', async (tx) =>
      (await tx.query<{ s: { may_act: boolean; status: string } }>(`select public.api_agent_status($1) s`, [res.api_key])).rows[0].s)
    expect(status).toMatchObject({ status: 'proposed', may_act: false })

    const actor = await db.query<{ actor_type: string }>(
      `select distinct actor_type from public.audit_events where agent_id = $1`, [res.agent_id])
    expect(actor.rows.map((r) => r.actor_type)).toEqual(['integration'])
  })

  it('keeps an incomplete registration as Proposed instead of submitting it', async () => {
    const res = await register(await integrationKey(), { name: 'Shadow vendor bot', origin: 'vendor', vendor_name: 'Acme AI' })
    expect(res.submitted_for_approval).toBe(false)
    expect(String(res.note)).toMatch(/business owner/)
  })

  it('refuses a wrong or revoked key, and bad field values', async () => {
    await expect(register('act_int_wrong', { name: 'x' })).rejects.toThrow(/Invalid or revoked/)
    const key = await integrationKey()
    await expect(register(key, { name: 'x', risk_tier: 'extreme' })).rejects.toThrow(/invalid value/)
    const keyId = (await db.query<{ id: string }>(`select id from public.integration_keys order by created_at desc limit 1`)).rows[0].id
    await asUser(db, u.admin, (tx) => tx.query(`select public.revoke_api_key($1)`, [keyId]))
    await expect(register(key, { name: 'x' })).rejects.toThrow(/Invalid or revoked/)
  })

  it('is reachable with the public key, but only a valid key gets through; signed-in users cannot call it', async () => {
    await expect(asRole(db, 'anon', (tx) => tx.query(`select public.api_register_agent('act_int_guess', '{"name":"x"}')`)))
      .rejects.toThrow(/Invalid or revoked/)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select public.api_agent_status('act_agt_guess')`)))
      .rejects.toThrow(/Invalid or revoked/)
    const key = await integrationKey()
    const res = await asRole(db, 'anon', async (tx) =>
      (await tx.query<{ r: { status: string } }>(`select public.api_register_agent($1, '{"name":"Via anon"}') r`, [key])).rows[0].r)
    expect(res.status).toBe('proposed')
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.api_register_agent('k', '{}')`))).rejects.toThrow(/permission denied/)
  })

  it('never exposes key hashes to users', async () => {
    await integrationKey()
    await expect(asUser(db, u.admin, (tx) => tx.query(`select key_hash from public.integration_keys`))).rejects.toThrow(/permission denied/)
    const ok = await asUser(db, u.admin, (tx) => tx.query(`select key_prefix from public.integration_keys`))
    expect(ok.rows.length).toBeGreaterThan(0)
  })
})
