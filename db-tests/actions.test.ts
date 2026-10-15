import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, proposeAgent } from './harness'

interface Answer {
  request_id: string
  request_code: string
  agent_code: string
  status: string
  may_proceed: boolean
  decision_source: string | null
  reason: string
  duplicate: boolean
}

describe('action requests (tasks 2.1 and 2.2)', () => {
  let db: PGlite
  let owner: string
  let other: string
  let dept: string

  beforeAll(async () => {
    db = await createDb()
    dept = await createDepartment(db, 'Payments')
    owner = await createUser(db, 'owner@bank.test', ['owner'])
    other = await createUser(db, 'other@bank.test', ['owner'])
  })

  /** A Live agent with the given autonomy settings, and its API key. */
  async function liveAgent(fields: Record<string, unknown>, status: 'live' | 'approved' | 'suspended' = 'live') {
    const id = await proposeAgent(db, owner, { department_id: dept, ...fields })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    if (status !== 'approved') await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    if (status === 'suspended') await db.query(`update public.agents set status = 'suspended' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    const key = await asUser(db, owner, async (tx) =>
      (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
    return { id, key }
  }

  /** Calls the API exactly as the Cloudflare function does: as the anonymous role, with the agent key. */
  const request = (key: string, payload: Record<string, unknown>) =>
    asRole(db, 'anon', async (tx) =>
      (await tx.query<{ r: Answer }>(`select public.api_request_action($1, $2::jsonb) r`, [key, JSON.stringify(payload)])).rows[0].r)

  const ask = (overrides: Record<string, unknown> = {}) => ({
    idempotency_key: crypto.randomUUID(), action: 'payment.release', amount: 100, currency: 'GBP',
    target_system: 'Payments hub', reasoning: 'Supplier invoice due today', ...overrides,
  })

  it('level 1 (Observe) is always refused', async () => {
    const { key } = await liveAgent({ autonomy_level: 1 })
    const r = await request(key, ask())
    expect(r).toMatchObject({ status: 'refused', may_proceed: false, decision_source: 'policy' })
    expect(r.reason).toMatch(/read and recommend only/)
  })

  it('level 2 always waits for a human', async () => {
    const { key } = await liveAgent({ autonomy_level: 2 })
    const r = await request(key, ask({ amount: 1 }))
    expect(r).toMatchObject({ status: 'pending', may_proceed: false, decision_source: null })
    expect(r.request_code).toMatch(/^REQ-\d{6}$/)
  })

  it('level 3 acts alone within its value limit and waits above it', async () => {
    const { key } = await liveAgent({ autonomy_level: 3, value_threshold: 5000, threshold_currency: 'GBP' })
    expect(await request(key, ask({ amount: 5000 }))).toMatchObject({ status: 'approved', may_proceed: true, decision_source: 'policy' })
    const big = await request(key, ask({ amount: 2_000_000 }))
    expect(big).toMatchObject({ status: 'pending', may_proceed: false })
    expect(big.reason).toMatch(/GBP 2,000,000.00 is above the GBP 5,000.00 limit/)
  })

  it('level 3 does not compare different currencies; it asks a human', async () => {
    const { key } = await liveAgent({ autonomy_level: 3, value_threshold: 5000, threshold_currency: 'GBP' })
    const r = await request(key, ask({ amount: 10, currency: 'usd' }))
    expect(r.status).toBe('pending')
    expect(r.reason).toMatch(/amount is in USD but the limit is in GBP/)
  })

  it('level 3 counts its approved actions over 24 hours against the volume limit', async () => {
    const { key } = await liveAgent({ autonomy_level: 3, value_threshold: 5000, volume_threshold: 3 })
    expect((await request(key, ask({ volume: 2 }))).status).toBe('approved')
    expect((await request(key, ask())).status).toBe('approved')
    const fourth = await request(key, ask())
    expect(fourth.status).toBe('pending')
    expect(fourth.reason).toMatch(/4 actions in 24 hours would exceed the limit of 3/)
  })

  it('level 4 acts alone, and the request is still recorded', async () => {
    const { id, key } = await liveAgent({ autonomy_level: 4 })
    const r = await request(key, ask({ amount: 9_999_999 }))
    expect(r).toMatchObject({ status: 'approved', may_proceed: true })
    const n = await db.query(`select 1 from public.action_requests where agent_id = $1`, [id])
    expect(n.rows).toHaveLength(1)
  })

  it('agents that are not Live are refused, whatever their level (fail closed)', async () => {
    for (const status of ['approved', 'suspended'] as const) {
      const { key } = await liveAgent({ autonomy_level: 4 }, status)
      const r = await request(key, ask())
      expect(r).toMatchObject({ status: 'refused', may_proceed: false })
      expect(r.reason).toMatch(new RegExp(`is ${status}\\. Only Live agents may act`))
    }
  })

  it('the same request sent twice is processed once and gets the same answer', async () => {
    const { id, key } = await liveAgent({ autonomy_level: 3, value_threshold: 5000, volume_threshold: 1 })
    const body = ask()
    const first = await request(key, body)
    const again = await request(key, body)
    expect(first.duplicate).toBe(false)
    expect(again).toMatchObject({ request_id: first.request_id, status: 'approved', duplicate: true })
    // Counted once: the retry did not use up the volume limit of 1.
    const n = await db.query(`select 1 from public.action_requests where agent_id = $1`, [id])
    expect(n.rows).toHaveLength(1)
  })

  it('reusing a key for a different request is refused', async () => {
    const { key } = await liveAgent({ autonomy_level: 4 })
    const body = ask()
    await request(key, body)
    await expect(request(key, { ...body, amount: 999 })).rejects.toThrow(/already used for a different request/)
  })

  it('validates the request with messages an integrator can act on', async () => {
    const { key } = await liveAgent({ autonomy_level: 4 })
    await expect(request(key, ask({ idempotency_key: '' }))).rejects.toThrow(/idempotency_key is required/)
    await expect(request(key, ask({ action: ' ' }))).rejects.toThrow(/action is required/)
    await expect(request(key, ask({ currency: undefined }))).rejects.toThrow(/currency is required with amount/)
    await expect(request(key, ask({ amount: -5 }))).rejects.toThrow(/cannot be negative/)
    await expect(request(key, ask({ amount: 'lots' }))).rejects.toThrow(/amount must be a number/)
    await expect(request(key, ask({ urgency: 'asap' }))).rejects.toThrow(/urgency one of low, normal, high, critical/)
    await expect(request(key, ask({ callback_url: 'http://insecure.test' }))).rejects.toThrow(/https/)
    await expect(request('act_agt_wrong', ask())).rejects.toThrow(/Invalid or revoked agent key/)
  })

  it('an approved request does not let a since-suspended agent proceed', async () => {
    const { id, key } = await liveAgent({ autonomy_level: 4 })
    const r = await request(key, ask())
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'suspended' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    const later = await asRole(db, 'anon', async (tx) =>
      (await tx.query<{ r: Answer }>(`select public.api_action_status($1, $2) r`, [key, r.request_code])).rows[0].r)
    expect(later).toMatchObject({ status: 'approved', may_proceed: false })
    expect(later.reason).toMatch(/now suspended\. Do not proceed/)
  })

  it("an agent can read only its own requests", async () => {
    const a = await liveAgent({ autonomy_level: 4 })
    const b = await liveAgent({ autonomy_level: 4 })
    const r = await request(a.key, ask())
    await expect(asRole(db, 'anon', (tx) => tx.query(`select public.api_action_status($1, $2)`, [b.key, r.request_code])))
      .rejects.toThrow(/No request/)
  })

  it('decided requests cannot be changed, and every request is audited as the agent', async () => {
    const { id, key } = await liveAgent({ autonomy_level: 4 })
    const r = await request(key, ask())
    await expect(db.query(`update public.action_requests set status = 'rejected' where id = $1`, [r.request_id]))
      .rejects.toThrow(/already decided/)
    const audit = await db.query<{ actor_type: string; actor_id: string; action: string }>(
      `select actor_type, actor_id, action from public.audit_events where entity_id = $1`, [r.request_id])
    expect(audit.rows).toEqual([{ actor_type: 'agent', actor_id: id, action: 'action_requests.insert' }])
  })

  it('people see requests only for agents they can see', async () => {
    const { key } = await liveAgent({ autonomy_level: 4 })
    await request(key, ask())
    const seen = (who: string) => asUser(db, who, async (tx) =>
      (await tx.query(`select 1 from public.action_requests`)).rows.length)
    expect(await seen(owner)).toBeGreaterThan(0)
    expect(await seen(other)).toBe(0)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select * from public.action_requests`))).rejects.toThrow(/permission denied/)
  })
})
