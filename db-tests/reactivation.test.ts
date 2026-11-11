import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 4.6: a suspended agent goes back to Live only through an approved request, then is switched back on everywhere
// it was stopped (unblocked on its platform and read back as active, key answered again, resume request, owner email).
describe('reactivation approval (task 4.6)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let conn: string
  const PLATFORM = 'Northbridge Agent Platform (simulated)'

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    const hr = await createDepartment(db, 'HR')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.admin2 = await createUser(db, 'admin2@bank.test', ['admin'], 'Second Admin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.omar = await createUser(db, 'omar@bank.test', ['approver'], 'Omar Farouk')
    u.audit = await createUser(db, 'audit@bank.test', ['auditor'], 'Aud Itor')
    await grantScope(db, u.ravi, payments)
    await grantScope(db, u.omar, hr)
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
    await db.query(`select public.platform_configure('appian_simulator', $1, 'https://appbay-demo.appiancloud.com', 'appian-key')`, [PLATFORM])
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id
  })

  /** A suspended agent (suspended by James), optionally on a platform, with a key, or Critical. */
  async function suspendedAgent(opts: { platform?: string; key?: boolean; critical?: boolean; endpoint?: string } = {}) {
    const id = await proposeAgent(db, u.james, { name: `Agent ${crypto.randomUUID().slice(0, 6)}`, department_id: payments,
      risk_tier: opts.critical ? 'critical' : 'high', control_endpoint: opts.endpoint ?? null })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    if (opts.key) await asUser(db, u.james, (tx) => tx.query(`select public.create_agent_api_key($1)`, [id]))
    if (opts.platform) {
      await db.query(`insert into public.platform_agents (connection_id, external_id, name, status, details, agent_id)
        values ($1, $2, 'Platform agent', 'active', '{}'::jsonb, $3)`, [conn, opts.platform, id])
    }
    await asUser(db, opts.critical ? u.admin : u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Paid the wrong supplier')`, [id]))
    if (opts.critical) {
      const s = (await db.query<{ id: string }>(`select id from public.agent_suspensions where agent_id = $1 and status = 'waiting'`, [id])).rows[0]
      if (s) await asUser(db, u.admin2, (tx) => tx.query(`select public.confirm_agent_suspension($1, null)`, [s.id]))
    }
    // The incident the suspension opened is contained, so reactivation may be asked for.
    const inc = (await db.query<{ id: string }>(`select id from public.incidents where agent_id = $1`, [id])).rows[0]
    await asUser(db, u.james, async (tx) => {
      await tx.query(`select public.incident_save_fields($1, '{"containment":"Agent suspended"}'::jsonb)`, [inc.id])
      await tx.query(`select public.incident_set_status($1, 'contained')`, [inc.id])
    })
    return { id, incident: inc.id }
  }
  const status = async (id: string) => (await db.query<{ s: string }>(`select status s from public.agents where id = $1`, [id])).rows[0].s
  const ask = (who: string, id: string, reason = 'Block list fixed and tested') =>
    asUser(db, who, async (tx) => (await tx.query<{ r: string }>(`select public.request_reactivation($1, $2) r`, [id, reason])).rows[0].r)
  const approve = (who: string, r: string) =>
    asUser(db, who, async (tx) => (await tx.query<{ r: string }>(`select public.approve_reactivation($1, 'Checked the fix') r`, [r])).rows[0].r)
  const restores = async (id: string) => (await db.query<{ method: string; status: string; detail: string | null }>(
    `select method, status, detail from public.agent_enforcements where agent_id = $1 and action = 'restore' order by id`, [id])).rows

  it('there is no switch: a suspended agent cannot be put Live directly', async () => {
    const { id } = await suspendedAgent()
    await expect(asUser(db, u.admin, (tx) => tx.query(`update public.agents set status = 'live' where id = $1`, [id])))
      .rejects.toThrow(/permission denied|change only through the approval workflow/)
    expect(await status(id)).toBe('suspended')
  })

  it('ask, then another person approves: the agent goes Live, its key is answered, and it is on the incident log', async () => {
    const { id, incident } = await suspendedAgent({ key: true })
    await db.query(`delete from public.push_outbox`)
    const r = await ask(u.james, id)
    expect((await db.query<{ status: string; required_approvals: number }>(`select status, required_approvals from public.agent_reactivations where id = $1`, [r])).rows[0])
      .toEqual({ status: 'pending', required_approvals: 1 })
    // Admins and the department's approver are asked (not James, who asked; not Omar, another department).
    const asked = (await db.query<{ user_id: string }>(`select user_id from public.push_outbox where kind = 'reactivation' order by user_id`)).rows.map((x) => x.user_id)
    expect(asked.sort()).toEqual([u.admin, u.admin2, u.ravi].sort())
    expect(await status(id)).toBe('suspended') // asking changes nothing yet

    await expect(approve(u.james, r)).rejects.toThrow(/Only admins and approvers/)     // an owner cannot approve
    await expect(approve(u.omar, r)).rejects.toThrow(/Only admins and approvers/)      // another department
    await expect(approve(u.audit, r)).rejects.toThrow(/Only admins and approvers/)
    expect(await approve(u.ravi, r)).toBe('approved')
    expect(await status(id)).toBe('live')
    expect(await restores(id)).toEqual([{ method: 'api', status: 'done', detail: 'Answered again: its checks and requests are handled normally' }])
    const reason = (await db.query<{ reason: string }>(`select reason from public.audit_events where entity_type = 'agents' and entity_id = $1 order by seq desc limit 1`, [id])).rows[0].reason
    expect(reason).toBe('Switched back on after approval by Ravi Menon: Block list fixed and tested')
    const note = (await db.query<{ body: string }>(`select body from public.incident_updates where incident_id = $1 order by created_at desc limit 1`, [incident])).rows[0].body
    expect(note).toMatch(/^AGT-\d{4} switched back on after approval by Ravi Menon: Block list fixed and tested$/)
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.push_outbox where user_id = $1 and title like 'Switched back on%'`, [u.james])).rows[0].n).toBe(1)
  })

  it('the person who asked can never approve it, even as an admin', async () => {
    const { id } = await suspendedAgent()
    const r = await ask(u.admin, id)
    await expect(approve(u.admin, r)).rejects.toThrow(/Someone other than the person who asked/)
    expect(await status(id)).toBe('suspended')
  })

  it('a Critical agent needs two different approvers', async () => {
    const { id } = await suspendedAgent({ critical: true })
    const r = await ask(u.james, id)
    expect(await approve(u.admin, r)).toBe('waiting')
    expect(await status(id)).toBe('suspended')
    await expect(approve(u.admin, r)).rejects.toThrow(/already approved it; a second person/)
    expect(await approve(u.ravi, r)).toBe('approved')
    expect(await status(id)).toBe('live')
    const reason = (await db.query<{ reason: string }>(`select reason from public.audit_events where entity_type = 'agents' and entity_id = $1 order by seq desc limit 1`, [id])).rows[0].reason
    expect(reason).toMatch(/^Switched back on after approval by Platform Admin and Ravi Menon:/)
  })

  it('cannot be asked while an incident is still Open, twice at once, or without a reason; reject and withdraw', async () => {
    const { id, incident } = await suspendedAgent()
    await asUser(db, u.james, (tx) => tx.query(`select public.incident_set_status($1, 'open', 'More payments found')`, [incident]))
    await expect(ask(u.james, id)).rejects.toThrow(/Contain the open incident first \(INC-\d{4}\)/)
    await asUser(db, u.james, (tx) => tx.query(`select public.incident_set_status($1, 'contained')`, [incident]))
    await expect(ask(u.james, id, ' ')).rejects.toThrow(/Say why it is safe/)
    await expect(ask(u.omar, id)).rejects.toThrow(/Only admins, the agent's owners/)
    const r = await ask(u.james, id)
    await expect(ask(u.ravi, id)).rejects.toThrow(/already waiting/)

    await expect(asUser(db, u.ravi, (tx) => tx.query(`select public.reject_reactivation($1, '')`, [r]))).rejects.toThrow(/Say why it stays suspended/)
    await asUser(db, u.ravi, (tx) => tx.query(`select public.reject_reactivation($1, 'Wait for the supplier to confirm')`, [r]))
    expect((await db.query<{ status: string; decision_reason: string }>(`select status, decision_reason from public.agent_reactivations where id = $1`, [r])).rows[0])
      .toEqual({ status: 'rejected', decision_reason: 'Wait for the supplier to confirm' })
    expect(await status(id)).toBe('suspended')
    await expect(approve(u.ravi, r)).rejects.toThrow(/already rejected/)

    const r2 = await ask(u.james, id)
    await expect(asUser(db, u.ravi, (tx) => tx.query(`select public.withdraw_reactivation($1)`, [r2]))).rejects.toThrow(/Only the person who asked, or an admin/)
    await asUser(db, u.james, (tx) => tx.query(`select public.withdraw_reactivation($1, 'Not yet')`, [r2]))
    expect((await db.query<{ status: string }>(`select status from public.agent_reactivations where id = $1`, [r2])).rows[0].status).toBe('withdrawn')
  })

  it('on a platform: unblocked there through our API, and it counts only once read back as active', async () => {
    const { id } = await suspendedAgent({ platform: 'NAP-004' })
    await db.query(`update public.platform_agents set status = 'blocked' where external_id = 'NAP-004'`)
    const r = await ask(u.james, id)
    await approve(u.ravi, r)
    expect((await restores(id)).map((x) => [x.method, x.status])).toEqual([['platform', 'pending']])
    const token = (await db.query<{ token: string }>(`select body ->> 'token' token from net.calls where url like '%/enforce/run' order by id desc limit 1`)).rows[0].token
    const work = await asRole(db, 'anon', async (tx) => (await tx.query<{ r: { platform: { id: number; action: string; external_id: string; reason: string }[] } }>(
      `select public.enforcement_claim($1) r`, [token])).rows[0].r)
    const mine = work.platform.find((w) => w.external_id === 'NAP-004')!
    expect(mine).toMatchObject({ action: 'restore', reason: expect.stringMatching(/^Switched back on in Agent Control Tower \(AGT-\d{4}\) after approval: Block list fixed and tested$/) })
    // Not confirmed: retried and the admins are alerted ("not switched back on yet").
    await asRole(db, 'anon', (tx) => tx.query(`select public.enforcement_report($1, $2::jsonb)`,
      [token, JSON.stringify([{ id: mine.id, ok: false, detail: 'Could not connect' }])]))
    const alert = (await db.query<{ message: string }>(`select message from public.alerts where agent_id = $1 and kind = 'enforcement_pending' and resolved_at is null`, [id])).rows[0]
    expect(alert.message).toMatch(/^AGT-\d{4} was approved to run again, but switching it back on at .* as NAP-004 has not worked yet: Could not connect\. Trying again at/)
    // Retried and confirmed: done, the platform record is active, and the alert clears.
    await db.query(`update public.agent_enforcements set next_attempt_at = now() - interval '1 second' where agent_id = $1 and action = 'restore'`, [id])
    await db.query(`select public.enforcement_kick()`)
    const t2 = (await db.query<{ token: string }>(`select body ->> 'token' token from net.calls where url like '%/enforce/run' order by id desc limit 1`)).rows[0].token
    const w2 = await asRole(db, 'anon', async (tx) => (await tx.query<{ r: { platform: { id: number; external_id: string }[] } }>(`select public.enforcement_claim($1) r`, [t2])).rows[0].r)
    await asRole(db, 'anon', (tx) => tx.query(`select public.enforcement_report($1, $2::jsonb)`,
      [t2, JSON.stringify([{ id: w2.platform.find((w) => w.external_id === 'NAP-004')!.id, ok: true, detail: 'Switched back on; read back as active' }])]))
    expect((await restores(id))[0]).toMatchObject({ status: 'done' })
    expect((await db.query<{ s: string }>(`select status s from public.platform_agents where external_id = 'NAP-004'`)).rows[0].s).toBe('active')
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.alerts where agent_id = $1 and kind = 'enforcement_pending' and resolved_at is null`, [id])).rows[0].n).toBe(0)
  })

  it('a control endpoint gets a signed agent.resume request; suspending again cancels an unfinished restore', async () => {
    const { id } = await suspendedAgent({ key: true, endpoint: 'https://agent.example.com/control' })
    await approve(u.ravi, await ask(u.james, id))
    const token = (await db.query<{ token: string }>(`select body ->> 'token' token from net.calls where url like '%/enforce/run' order by id desc limit 1`)).rows[0].token
    const work = await asRole(db, 'anon', async (tx) => (await tx.query<{ r: { webhooks: { url: string; event: string; body: string; signature: string | null }[] } }>(
      `select public.enforcement_claim($1) r`, [token])).rows[0].r)
    const hook = work.webhooks.find((h) => h.url === 'https://agent.example.com/control')!
    expect(hook.event).toBe('agent.resume')
    expect(JSON.parse(hook.body)).toMatchObject({ event: 'agent.resume', status: 'live', reason: 'Block list fixed and tested' })
    expect(hook.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)

    await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Again')`, [id]))
    expect((await restores(id)).find((x) => x.method === 'webhook')).toMatchObject({ status: 'cancelled' })
  })

  it('retiring a suspended agent withdraws a waiting request', async () => {
    const { id } = await suspendedAgent()
    const r = await ask(u.james, id)
    await asUser(db, u.admin, (tx) => tx.query(`select public.retire_agent($1, 'Replaced')`, [id]))
    expect((await db.query<{ status: string; decision_reason: string }>(`select status, decision_reason from public.agent_reactivations where id = $1`, [r])).rows[0])
      .toEqual({ status: 'withdrawn', decision_reason: 'The agent was retired' })
  })
})
