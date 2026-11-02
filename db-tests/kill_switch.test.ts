import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 4.1: the kill switch.
describe('kill switch (task 4.1)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    const ops = await createDepartment(db, 'Operations')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.daniel = await createUser(db, 'daniel@bank.test', ['approver'], 'Daniel Okafor')
    u.omar = await createUser(db, 'omar@bank.test', ['approver'], 'Omar Farouk')
    u.priya = await createUser(db, 'priya@bank.test', ['executive'], 'Priya Sharma')
    u.mei = await createUser(db, 'mei@bank.test', ['auditor'], 'Mei Lin')
    for (const p of [u.ravi, u.daniel]) await grantScope(db, p, payments)
    await grantScope(db, u.omar, ops)
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
  })

  async function liveAgent(risk: 'medium' | 'critical' = 'medium') {
    const id = await proposeAgent(db, u.james, { name: `Agent ${crypto.randomUUID().slice(0, 6)}`, department_id: payments,
      autonomy_level: 3, value_threshold: 250000, threshold_currency: 'GBP', risk_tier: risk })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    const key = await asUser(db, u.james, async (tx) => (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
    return { id, key }
  }
  const suspend = (who: string, id: string, reason: string | null = 'Paying the wrong supplier') =>
    asUser(db, who, async (tx) => (await tx.query<{ r: string }>(`select public.suspend_agent($1, $2) r`, [id, reason])).rows[0].r)
  const statusOf = async (id: string) => (await db.query<{ status: string }>(`select status from public.agents where id = $1`, [id])).rows[0].status
  const agentSays = (key: string) => asRole(db, 'anon', async (tx) =>
    (await tx.query<{ r: { status: string; may_act: boolean } }>(`select public.api_agent_status($1) r`, [key])).rows[0].r)
  const setFourEyes = (who: string, on: boolean) => asUser(db, who, (tx) => tx.query(`select public.set_kill_switch_settings($1)`, [on]))

  it('one action with a reason suspends a Live agent, and the agent is refused at its very next check', async () => {
    const { id, key } = await liveAgent()
    expect(await agentSays(key)).toMatchObject({ status: 'live', may_act: true })
    expect(await suspend(u.james, id)).toBe('suspended')
    expect(await statusOf(id)).toBe('suspended')
    expect(await agentSays(key)).toMatchObject({ status: 'suspended', may_act: false })
    const row = (await db.query<{ status: string; reason: string; requested_by: string; suspended_at: string | null }>(
      `select status, reason, requested_by, suspended_at from public.agent_suspensions where agent_id = $1`, [id])).rows
    expect(row).toEqual([{ status: 'done', reason: 'Paying the wrong supplier', requested_by: u.james, suspended_at: expect.anything() }])
    const audit = (await db.query<{ summary: string; reason: string; actor_id: string }>(
      `select summary, reason, actor_id from public.audit_events where agent_id = $1 and action = 'agents.status_changed' order by seq desc limit 1`, [id])).rows[0]
    expect(audit).toMatchObject({ reason: 'Suspended: Paying the wrong supplier', actor_id: u.james })
    expect(audit.summary).toMatch(/: live → suspended$/)
  })

  it('a suspended agent cannot ask, and what it asked before cannot be approved', async () => {
    const { id, key } = await liveAgent()
    const asked = await asRole(db, 'anon', async (tx) => (await tx.query<{ r: { request_id: string; status: string } }>(
      `select public.api_request_action($1, $2::jsonb) r`, [key, JSON.stringify({ idempotency_key: 'k1', action: 'payment.release', amount: 2_000_000, currency: 'GBP' })])).rows[0].r)
    expect(asked.status).toBe('pending')
    await suspend(u.admin, id, 'Incident INC-0007')
    await expect(asUser(db, u.ravi, (tx) => tx.query(`select public.decide_action_request($1, 'approve', null)`, [asked.request_id])))
      .rejects.toThrow(/cannot be approved/)
    const again = await asRole(db, 'anon', async (tx) => (await tx.query<{ r: { status: string } }>(
      `select public.api_request_action($1, $2::jsonb) r`, [key, JSON.stringify({ idempotency_key: 'k2', action: 'payment.release', amount: 10, currency: 'GBP' })])).rows[0].r)
    expect(again.status).toBe('refused')
  })

  it('needs a reason and a Live agent; executives, auditors and approvers for other departments cannot pull it', async () => {
    const { id } = await liveAgent()
    await expect(suspend(u.james, id, '  ')).rejects.toThrow(/Say why/)
    await expect(suspend(u.james, id, null)).rejects.toThrow(/Say why/)
    for (const who of [u.priya, u.mei]) await expect(suspend(who, id)).rejects.toThrow(/Only admins, the agent's owners and approvers/)
    await expect(suspend(u.omar, id)).rejects.toThrow(/Agent not found/) // cannot even see a Payments agent
    expect(await suspend(u.ravi, id)).toBe('suspended') // approver for Payments
    await expect(suspend(u.admin, id)).rejects.toThrow(/Only Live agents can be suspended .* is suspended/)
  })

  it('a Critical agent is suspended at once unless admins require a second person', async () => {
    expect(await suspend(u.james, (await liveAgent('critical')).id)).toBe('suspended')
    await expect(setFourEyes(u.ravi, true)).rejects.toThrow(/Only admins/)
    await setFourEyes(u.admin, true)
    expect((await db.query<{ reason: string }>(
      `select reason from public.audit_events where entity_type = 'kill_switch_settings' order by seq desc limit 1`)).rows[0].reason)
      .toBe('Critical agents need a second person to suspend')
    // A medium-risk agent is still instant.
    expect(await suspend(u.james, (await liveAgent()).id)).toBe('suspended')
  })

  it('with four-eyes on, the first press waits and alerts the others; a different person confirms', async () => {
    const { id, key } = await liveAgent('critical')
    await db.query(`delete from public.push_outbox`)
    expect(await suspend(u.james, id, 'Unusual payments overnight')).toBe('waiting')
    expect(await statusOf(id)).toBe('live')
    expect(await agentSays(key)).toMatchObject({ may_act: true })
    const alerted = (await db.query<{ user_id: string; title: string; url: string }>(
      `select user_id, title, url from public.push_outbox where kind = 'suspension' order by user_id`)).rows
    expect(alerted.map((a) => a.user_id).sort()).toEqual([u.admin, u.ravi, u.daniel].sort()) // not James (asked), not Omar (other dept)
    expect(alerted[0]).toMatchObject({ title: expect.stringMatching(/^Confirm suspension · AGT-/), url: `/agents/${id}` })

    const waiting = (await db.query<{ id: string }>(`select id from public.agent_suspensions where agent_id = $1 and status = 'waiting'`, [id])).rows[0].id
    await expect(suspend(u.ravi, id)).rejects.toThrow(/already waiting for a second person/)
    await expect(asUser(db, u.james, (tx) => tx.query(`select public.confirm_agent_suspension($1)`, [waiting]))).rejects.toThrow(/A second person must confirm/)
    await expect(asUser(db, u.priya, (tx) => tx.query(`select public.confirm_agent_suspension($1)`, [waiting]))).rejects.toThrow(/Only admins/)
    await asUser(db, u.daniel, (tx) => tx.query(`select public.confirm_agent_suspension($1, 'Agreed')`, [waiting]))
    expect(await statusOf(id)).toBe('suspended')
    expect(await agentSays(key)).toMatchObject({ may_act: false })
    expect((await db.query(`select status, confirmed_by, confirm_note from public.agent_suspensions where id = $1`, [waiting])).rows[0])
      .toEqual({ status: 'done', confirmed_by: u.daniel, confirm_note: 'Agreed' })
  })

  it('a waiting request can be withdrawn by the person who asked or an admin, and closes if the agent is retired', async () => {
    const one = await liveAgent('critical')
    await suspend(u.james, one.id)
    const s1 = (await db.query<{ id: string }>(`select id from public.agent_suspensions where agent_id = $1 and status = 'waiting'`, [one.id])).rows[0].id
    await expect(asUser(db, u.ravi, (tx) => tx.query(`select public.withdraw_agent_suspension($1, 'No')`, [s1]))).rejects.toThrow(/Only the person who asked, or an admin/)
    await expect(asUser(db, u.james, (tx) => tx.query(`select public.withdraw_agent_suspension($1, '')`, [s1]))).rejects.toThrow(/Say why/)
    await asUser(db, u.james, (tx) => tx.query(`select public.withdraw_agent_suspension($1, 'False alarm: the payments were expected')`, [s1]))
    expect(await statusOf(one.id)).toBe('live')

    const two = await liveAgent('critical')
    await suspend(u.ravi, two.id)
    await asUser(db, u.admin, (tx) => tx.query(`select public.retire_agent($1, 'Replaced')`, [two.id]))
    expect((await db.query<{ status: string; withdraw_reason: string }>(
      `select status, withdraw_reason from public.agent_suspensions where agent_id = $1`, [two.id])).rows[0])
      .toEqual({ status: 'withdrawn', withdraw_reason: 'The agent became retired' })
    await setFourEyes(u.admin, false)
  })

  it('suspensions are visible with the agent only', async () => {
    const seen = (who: string) => asUser(db, who, async (tx) => (await tx.query(`select id from public.agent_suspensions`)).rows.length)
    expect(await seen(u.mei)).toBeGreaterThan(0)
    expect(await seen(u.omar)).toBe(0)
    await expect(asUser(db, u.admin, (tx) => tx.query(`insert into public.agent_suspensions (agent_id, status, reason, requested_by)
      select id, 'done', 'x', $1 from public.agents limit 1`, [u.admin]))).rejects.toThrow(/permission denied/)
  })
})
