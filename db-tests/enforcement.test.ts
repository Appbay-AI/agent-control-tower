import { createHash, createHmac } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 4.2: when an agent is suspended, it is stopped every way the Control Tower can reach it.
describe('enforcement by source (task 4.2)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let conn: string
  const PLATFORM = 'Northbridge Agent Platform (simulated)'

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.admin2 = await createUser(db, 'admin2@bank.test', ['admin'], 'Second Admin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    await grantScope(db, u.ravi, payments)
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
    await db.query(`select public.platform_configure('appian_simulator', $1, 'https://appbay-demo.appiancloud.com', 'appian-key')`, [PLATFORM])
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id
  })

  /** A Live agent; optionally with a key, a control endpoint, a platform link, or no owner. */
  async function liveAgent(opts: { key?: boolean; endpoint?: string; platform?: string; noOwner?: boolean } = {}) {
    const id = await proposeAgent(db, u.james, { name: `Agent ${crypto.randomUUID().slice(0, 6)}`, department_id: payments,
      control_endpoint: opts.endpoint ?? null })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    if (opts.noOwner) await db.query(`update public.agents set business_owner_id = null where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    let key: string | null = null
    if (opts.key) key = await asUser(db, u.james, async (tx) => (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
    if (opts.platform) {
      await db.query(`insert into public.platform_agents (connection_id, external_id, name, status, details, agent_id)
        values ($1, $2, 'Platform agent', 'active', '{}'::jsonb, $3)`, [conn, opts.platform, id])
    }
    return { id, key }
  }
  const suspend = (who: string, id: string, reason = 'Paying the wrong supplier') =>
    asUser(db, who, (tx) => tx.query(`select public.suspend_agent($1, $2)`, [id, reason]))
  type Row = { method: string; status: string; target: string; detail: string | null }
  const plan = async (id: string) => (await db.query<Row>(
    `select method, status, target, detail from public.agent_enforcements where agent_id = $1 order by id`, [id])).rows
  const lastToken = async () => (await db.query<{ url: string; token: string }>(
    `select url, body ->> 'token' token from net.calls where url like '%/enforce/run' order by id desc limit 1`)).rows[0]
  const claim = (token: string) => asRole(db, 'anon', async (tx) => (await tx.query<{ r: Claimed }>(`select public.enforcement_claim($1) r`, [token])).rows[0].r)
  const report = (token: string, results: unknown[]) => asRole(db, 'anon', async (tx) =>
    (await tx.query<{ n: number }>(`select public.enforcement_report($1, $2::jsonb) n`, [token, JSON.stringify(results)])).rows[0].n)
  type Claimed = {
    platform: { id: number; external_id: string; reason: string; connection: { kind: string; base_url: string; secret: string; name: string } }[]
    webhooks: { id: number; url: string; body: string; signature: string | null; event: string }[]
    emails: { id: number; to_name: string; to_email: string; owner: boolean; reason: string; suspended_by: string; agent: { code: string; name: string } }[]
  }

  it('an agent that only calls our API is refused from that moment; nothing needs sending', async () => {
    const { id } = await liveAgent({ key: true })
    const calls = (await db.query<{ n: number }>(`select count(*)::int n from net.calls where url like '%/enforce/run'`)).rows[0].n
    await suspend(u.james, id)
    expect(await plan(id)).toEqual([{ method: 'api', status: 'done', target: 'Its API key',
      detail: 'Refused from now on: every check and request it makes with its key' }])
    expect((await db.query<{ n: number }>(`select count(*)::int n from net.calls where url like '%/enforce/run'`)).rows[0].n).toBe(calls)
  })

  it('an agent on a platform is blocked there through our API, and it counts only once read back as blocked', async () => {
    const { id } = await liveAgent({ key: true, platform: 'NAP-001' })
    await suspend(u.ravi, id, 'Incident INC-0007')
    expect((await plan(id)).map((r) => [r.method, r.status, r.target])).toEqual([
      ['platform', 'pending', `${PLATFORM} as NAP-001`], ['api', 'done', 'Its API key']])
    const { url, token } = await lastToken()
    expect(url).toBe('https://main.example.pages.dev/api/v1/enforce/run')
    expect(token).toMatch(/^ent_[0-9a-f]{64}$/)

    const work = await claim(token)
    expect(work.platform).toHaveLength(1)
    expect(work.platform[0]).toMatchObject({ external_id: 'NAP-001',
      reason: expect.stringMatching(/^Suspended in Agent Control Tower \(AGT-\d{4}\): Incident INC-0007$/),
      connection: { kind: 'appian_simulator', base_url: 'https://appbay-demo.appiancloud.com', secret: 'appian-key', name: PLATFORM } })
    await expect(claim(token)).rejects.toThrow(/Invalid or used enforcement token/)

    expect(await report(token, [{ id: work.platform[0].id, ok: true, detail: `Blocked on ${PLATFORM} as NAP-001; read back as blocked` }])).toBe(1)
    expect((await plan(id))[0]).toMatchObject({ status: 'done', detail: `Blocked on ${PLATFORM} as NAP-001; read back as blocked` })
    expect((await db.query<{ status: string }>(`select status from public.platform_agents where agent_id = $1`, [id])).rows[0].status).toBe('blocked')
    await expect(report(token, [])).rejects.toThrow(/Invalid or used enforcement token/)
  })

  it('a failed block stays pending and is tried again; the admins are alerted once (task 4.3)', async () => {
    const { id } = await liveAgent({ platform: 'NAP-005' })
    await db.query(`delete from public.push_outbox`)
    await suspend(u.james, id)
    const { token } = await lastToken()
    const work = await claim(token)
    await report(token, [{ id: work.platform[0].id, ok: false, detail: 'The Appian simulator did not answer within 15 seconds.' }])
    const row = (await db.query<{ status: string; detail: string; attempts: number; wait: number; agent: string }>(
      `select e.status, e.detail, e.attempts, extract(epoch from e.next_attempt_at - now())::int wait, a.status agent
         from public.agent_enforcements e join public.agents a on a.id = e.agent_id where e.agent_id = $1`, [id])).rows[0]
    expect(row).toMatchObject({ status: 'pending', detail: 'The Appian simulator did not answer within 15 seconds.', attempts: 1, agent: 'suspended' })
    expect(row.wait).toBeGreaterThan(50) // about a minute
    expect((await db.query<{ status: string }>(`select status from public.platform_agents where agent_id = $1`, [id])).rows[0].status).toBe('active')
    const alert = (await db.query<{ message: string }>(`select message from public.alerts where agent_id = $1 and kind = 'enforcement_pending' and resolved_at is null`, [id])).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].message).toMatch(/^AGT-\d{4} is suspended, but stopping it on Northbridge Agent Platform \(simulated\) as NAP-005 has not worked yet: The Appian simulator did not answer within 15 seconds\. Trying again at \d\d:\d\d UTC\.$/)
    const pushes = (await db.query<{ user_id: string; title: string }>(`select user_id, title from public.push_outbox where kind = 'enforcement'`)).rows
    expect(pushes.map((p) => p.user_id).sort()).toEqual([u.admin, u.admin2].sort())
    expect(pushes[0].title).toMatch(/^Not stopped yet · AGT-/)

    // Not due yet: the clock does not ask again.
    const calls = (await db.query<{ n: number }>(`select count(*)::int n from net.calls where url like '%/enforce/run'`)).rows[0].n
    await db.query(`select public.enforcement_kick()`)
    expect((await db.query<{ n: number }>(`select count(*)::int n from net.calls where url like '%/enforce/run'`)).rows[0].n).toBe(calls)

    // Due: tried again; fails again (no second phone alert), then works: done, alert cleared.
    await db.query(`update public.agent_enforcements set next_attempt_at = now() - interval '1 second' where agent_id = $1`, [id])
    await db.query(`select public.enforcement_kick()`)
    let t = (await lastToken()).token
    let w = await claim(t)
    await report(t, [{ id: w.platform[0].id, ok: false, detail: 'HTTP 503 from Appian' }])
    expect((await db.query<{ attempts: number; status: string }>(`select attempts, status from public.agent_enforcements where agent_id = $1`, [id])).rows[0])
      .toEqual({ attempts: 2, status: 'pending' })
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.push_outbox where kind = 'enforcement'`)).rows[0].n).toBe(2)
    expect((await db.query<{ message: string }>(`select message from public.alerts where agent_id = $1 and kind = 'enforcement_pending' and resolved_at is null`, [id])).rows[0].message)
      .toContain('HTTP 503 from Appian')

    await db.query(`update public.agent_enforcements set next_attempt_at = now() - interval '1 second' where agent_id = $1`, [id])
    await db.query(`select public.enforcement_kick()`)
    t = (await lastToken()).token
    w = await claim(t)
    await report(t, [{ id: w.platform[0].id, ok: true, detail: `Blocked on ${PLATFORM} as NAP-005; read back as blocked` }])
    expect(await plan(id)).toEqual([{ method: 'platform', status: 'done', target: `${PLATFORM} as NAP-005`, detail: `Blocked on ${PLATFORM} as NAP-005; read back as blocked` }])
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.alerts where agent_id = $1 and kind = 'enforcement_pending' and resolved_at is null`, [id])).rows[0].n).toBe(0)
  })

  it('backs off: 1, 2, 5, 15 and 30 minutes, then every hour', async () => {
    const waits = (await db.query<{ m: number }>(
      `select extract(epoch from public.enforcement_backoff(n))::int / 60 m from generate_series(1, 8) n order by n`)).rows.map((r) => r.m)
    expect(waits).toEqual([1, 2, 5, 15, 30, 60, 60, 60])
  })

  it('a step that cannot work by retrying is failed and left to a person; the alert says so', async () => {
    const { id } = await liveAgent()
    await suspend(u.ravi, id)
    const t = (await lastToken()).token
    const w = await claim(t)
    await report(t, [{ id: w.emails[0].id, ok: false, retry: false, detail: 'Email to James Whitfield not sent: james@bank.test is not a real mailbox' }])
    expect((await plan(id))[0]).toMatchObject({ status: 'failed' })
    expect((await db.query<{ message: string }>(`select message from public.alerts where agent_id = $1 and kind = 'enforcement_pending' and resolved_at is null`, [id])).rows[0].message)
      .toMatch(/Trying again cannot fix this: a person needs to act\.$/)
  })

  it('stops trying, and clears the alert, once the agent is no longer suspended', async () => {
    const { id } = await liveAgent({ platform: 'NAP-006' })
    await suspend(u.james, id)
    const t = (await lastToken()).token
    const w = await claim(t)
    await report(t, [{ id: w.platform[0].id, ok: false, detail: 'Could not connect' }])
    await asUser(db, u.admin, (tx) => tx.query(`select public.retire_agent($1, 'Replaced')`, [id]))
    expect((await plan(id))[0]).toMatchObject({ status: 'cancelled', detail: 'Could not connect. Stopped trying: the agent is now retired' })
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.alerts where agent_id = $1 and kind = 'enforcement_pending' and resolved_at is null`, [id])).rows[0].n).toBe(0)
  })

  it('an agent with a control endpoint gets a stop request, signed with its own key', async () => {
    const { id, key } = await liveAgent({ key: true, endpoint: 'https://agent.example.com/act/stop' })
    await suspend(u.james, id, 'Stop now')
    expect((await plan(id)).map((r) => [r.method, r.status])).toEqual([['api', 'done'], ['webhook', 'pending']])
    const work = await claim((await lastToken()).token)
    const hook = work.webhooks[0]
    expect(hook).toMatchObject({ url: 'https://agent.example.com/act/stop', event: 'agent.stop' })
    expect(JSON.parse(hook.body)).toMatchObject({ event: 'agent.stop', agent_id: id, status: 'suspended', reason: 'Stop now', delivery_id: hook.id })
    // The agent checks it the same way as a decision callback: HMAC-SHA256, key = SHA-256 of its own key.
    const [, t, v1] = hook.signature!.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!
    const secret = createHash('sha256').update(key!).digest('hex')
    expect(createHmac('sha256', secret).update(`${t}.${hook.body}`).digest('hex')).toBe(v1)
  })

  it('an agent we cannot reach: its owner is emailed and asked to switch it off', async () => {
    const { id } = await liveAgent()
    await suspend(u.ravi, id, 'Unapproved data use')
    expect(await plan(id)).toEqual([{ method: 'email', status: 'pending', target: 'James Whitfield (james@bank.test)', detail: null }])
    const work = await claim((await lastToken()).token)
    expect(work.emails).toEqual([expect.objectContaining({ to_name: 'James Whitfield', to_email: 'james@bank.test', owner: true,
      reason: 'Unapproved data use', suspended_by: 'Ravi Menon', agent: expect.objectContaining({ name: expect.stringMatching(/^Agent /) }) })])
  })

  it('with no owner, every admin is asked instead', async () => {
    const { id } = await liveAgent({ noOwner: true })
    await suspend(u.admin, id)
    expect((await plan(id)).map((r) => r.target).sort()).toEqual(['Platform Admin (admin@bank.test)', 'Second Admin (admin2@bank.test)'])
  })

  it('the record is visible with the agent, and only our API can claim or report work', async () => {
    const seen = (who: string) => asUser(db, who, async (tx) => (await tx.query(`select id from public.agent_enforcements`)).rows.length)
    expect(await seen(u.admin)).toBeGreaterThan(0)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select * from public.agent_enforcements`))).rejects.toThrow(/permission denied/)
    await expect(claim('ent_' + '0'.repeat(64))).rejects.toThrow(/Invalid or used enforcement token/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.enforcement_claim('x')`))).rejects.toThrow(/permission denied/)
  })
})
