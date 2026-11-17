import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, proposeAgent } from './harness'

// Task 5.5 (added 13 Nov): retiring an agent also blocks it on its platform, read back as blocked, with the same retries
// and admin alerts as the kill switch. Done when: a retired Appian agent reads back as blocked.
describe('retiring blocks the agent on its platform (task 5.5)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let conn: string
  const PLATFORM = 'Northbridge Agent Platform (simulated)'

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
    await db.query(`select public.platform_configure('appian_simulator', $1, 'https://appbay-demo.appiancloud.com', 'appian-key')`, [PLATFORM])
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id
  })

  async function agentOn(external: string | null, opts: { live?: boolean; missing?: boolean } = { live: true }) {
    const id = await proposeAgent(db, u.james, { name: `Agent ${crypto.randomUUID().slice(0, 6)}`, department_id: payments })
    if (opts.live) {
      await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
      await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
      await db.query(`update public.agents set status = 'live' where id = $1`, [id])
      await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    }
    if (external) {
      await db.query(`insert into public.platform_agents (connection_id, external_id, name, status, details, agent_id, missing_since)
        values ($1, $2, 'Platform agent', 'active', '{}'::jsonb, $3, $4)`, [conn, external, id, opts.missing ? new Date().toISOString() : null])
    }
    return id
  }
  const retire = (who: string, id: string, reason = 'Replaced by the new matching service') =>
    asUser(db, who, (tx) => tx.query(`select public.retire_agent($1, $2)`, [id, reason]))
  const steps = async (id: string) => (await db.query<{ cause: string; method: string; status: string; target: string; detail: string | null; reason: string | null }>(
    `select cause, method, status, target, detail, reason from public.agent_enforcements where agent_id = $1 order by id`, [id])).rows
  const lastToken = async () => (await db.query<{ token: string }>(`select body ->> 'token' token from net.calls where url like '%/enforce/run' order by id desc limit 1`)).rows[0]?.token
  type Claimed = { platform: { id: number; external_id: string; action: string; reason: string }[] }
  const claim = async (t: string) => asRole(db, 'anon', async (tx) => (await tx.query<{ r: Claimed }>(`select public.enforcement_claim($1) r`, [t])).rows[0].r)
  const report = (t: string, results: unknown[]) => asRole(db, 'anon', (tx) => tx.query(`select public.enforcement_report($1, $2::jsonb)`, [t, JSON.stringify(results)]))
  const platformStatus = async (external: string) => (await db.query<{ status: string }>(`select status from public.platform_agents where external_id = $1`, [external])).rows[0].status

  it('retired: a block step for its Appian agent, sent with the reason; it counts once read back as blocked', async () => {
    const id = await agentOn('NAP-006')
    await retire(u.james, id)
    expect(await steps(id)).toEqual([{ cause: 'retirement', method: 'platform', status: 'pending', target: `${PLATFORM} as NAP-006`, detail: null,
      reason: 'Replaced by the new matching service' }])
    const t = await lastToken()
    const w = await claim(t)
    const code = (await db.query<{ c: string }>(`select agent_code c from public.agents where id = $1`, [id])).rows[0].c
    expect(w.platform).toEqual([expect.objectContaining({ external_id: 'NAP-006', action: 'stop', reason: `Retired in Agent Control Tower (${code}): Replaced by the new matching service` })])
    await report(t, [{ id: w.platform[0].id, ok: true, detail: 'Blocked; read back as blocked' }])
    expect((await steps(id))[0]).toMatchObject({ status: 'done', detail: 'Blocked; read back as blocked' })
    expect(await platformStatus('NAP-006')).toBe('blocked')
  })

  it('Appian does not answer: kept and tried again; the admins are alerted that a retired agent is not blocked yet', async () => {
    const id = await agentOn('NAP-005')
    await retire(u.admin, id, 'No longer used')
    let t = await lastToken()
    let w = await claim(t)
    await report(t, [{ id: w.platform[0].id, ok: false, detail: 'Appian did not answer', retry: true }])
    expect((await steps(id))[0]).toMatchObject({ status: 'pending', detail: 'Appian did not answer' })
    const alert = (await db.query<{ message: string }>(`select message from public.alerts where agent_id = $1 and kind = 'enforcement_pending' and resolved_at is null`, [id])).rows[0].message
    expect(alert).toMatch(new RegExp(`^AGT-\\d{4} is retired, but blocking it on ${PLATFORM.replace(/[()]/g, '\\$&')} as NAP-005 has not worked yet: Appian did not answer\\. Trying again at \\d\\d:\\d\\d UTC\\.$`))
    const email = (await db.query<{ headline: string }>(`select details ->> 'headline' headline from public.email_outbox where agent_id = $1 and event = 'enforcement_pending' and user_id = $2`, [id, u.admin])).rows[0]
    expect(email.headline).toMatch(/is retired but not blocked on its platform yet$/)
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.push_outbox where user_id = $1 and kind = 'alert' and title like 'Not stopped yet%'`, [u.admin])).rows[0].n).toBeGreaterThan(0)

    // The retry works: blocked, read back, alert cleared.
    await db.query(`update public.agent_enforcements set next_attempt_at = now() - interval '1 second' where agent_id = $1`, [id])
    await db.query(`select public.enforcement_kick()`)
    t = await lastToken()
    w = await claim(t)
    await report(t, [{ id: w.platform[0].id, ok: true, detail: 'Blocked; read back as blocked' }])
    expect(await platformStatus('NAP-005')).toBe('blocked')
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.alerts where agent_id = $1 and kind = 'enforcement_pending' and resolved_at is null`, [id])).rows[0].n).toBe(0)
  })

  it('a Proposed (discovered) agent too; nothing for one no longer listed on its platform or not on any platform', async () => {
    const proposed = await agentOn('NAP-004', { live: false })
    await retire(u.james, proposed, 'Shadow agent, not wanted')
    expect((await steps(proposed)).map((x) => x.cause)).toEqual(['retirement'])
    const gone = await agentOn('NAP-008', { live: true, missing: true })
    await retire(u.james, gone)
    expect(await steps(gone)).toEqual([])
    const plain = await agentOn(null)
    await retire(u.james, plain)
    expect(await steps(plain)).toEqual([])
  })

  it('who may retire is unchanged: its business owner or an admin, with a reason', async () => {
    const id = await agentOn('NAP-003')
    await expect(retire(u.ravi, id)).rejects.toThrow(/Only the business owner or an admin/)
    await expect(retire(u.james, id, ' ')).rejects.toThrow(/A reason is required/)
    expect(await steps(id)).toEqual([])
  })
})
