import { createHash, createHmac } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 2.8: the decision goes back to the agent: a signed callback when a person decides, and the agent console.
describe('decision callbacks (task 2.8)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  const SITE = 'https://main.example.pages.dev'
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.owner = await createUser(db, 'owner@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    await grantScope(db, u.ravi, payments)
    await db.query(`select public.push_configure($1)`, [SITE])
    await asUser(db, u.admin, (tx) => tx.query(
      `insert into public.routing_rules (name, priority, min_amount, currency, approver_id) values ('Large', 10, 1000000, 'GBP', $1)`, [u.ravi]))
  })

  beforeEach(async () => {
    await db.query(`delete from public.callback_outbox`)
    await db.query(`delete from net.calls`)
  })

  async function liveAgent(name = `Agent ${crypto.randomUUID().slice(0, 6)}`) {
    const id = await proposeAgent(db, u.owner, { name, department_id: payments, autonomy_level: 3, value_threshold: 250000, threshold_currency: 'GBP' })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    const key = await asUser(db, u.owner, async (tx) => (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
    return { id, key }
  }

  const ask = async (key: string, amount = 2_000_000, callback: string | null = 'https://agent.example.com/act/decisions') =>
    asRole(db, 'anon', async (tx) =>
      (await tx.query<{ r: { request_id: string; request_code: string; status: string } }>(`select public.api_request_action($1, $2::jsonb) r`, [key, JSON.stringify({
        idempotency_key: crypto.randomUUID(), action: 'payment.release', amount, currency: 'GBP',
        description: 'Release £2,000,000 to supplier Hartwell Steel Ltd', ...(callback ? { callback_url: callback } : {}),
      })])).rows[0].r)

  const decide = (id: string, d: 'approve' | 'reject', reason: string | null = null) =>
    asUser(db, u.ravi, (tx) => tx.query(`select public.decide_action_request($1, $2, $3)`, [id, d, reason]))

  type Cb = { id: number; url: string; body: string; signature: string; request_id: string }
  const latestToken = async () => (await db.query<{ t: string }>(`select body ->> 'token' t from net.calls order by id desc limit 1`)).rows[0].t
  const claim = async (t: string) => asRole(db, 'anon', async (tx) => (await tx.query<{ r: { callbacks: Cb[] } }>(`select public.push_claim($1) r`, [t])).rows[0].r)
  const report = (t: string, results: unknown) => asRole(db, 'anon', (tx) => tx.query(`select public.push_report($1, $2::jsonb)`, [t, JSON.stringify(results)]))

  /** What an agent does with a callback: check the signature with its own key. */
  function verify(cb: Cb, agentKey: string) {
    const [, t, v1] = cb.signature.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!
    return createHmac('sha256', sha(agentKey)).update(`${t}.${cb.body}`).digest('hex') === v1
  }

  it('records which key made each request', async () => {
    const { key } = await liveAgent()
    const r = await ask(key)
    const row = await db.query<{ ok: boolean }>(
      `select r.api_key_id = k.id ok from public.action_requests r join public.agent_api_keys k on k.key_hash = public.secret_hash($2) where r.id = $1`, [r.request_id, key])
    expect(row.rows[0].ok).toBe(true)
  })

  it('when a person decides, the agent is called back with the decision, signed with its own key', async () => {
    const { key } = await liveAgent()
    const r = await ask(key)
    await decide(r.request_id, 'approve', 'Invoice checked')
    const got = await claim(await latestToken())
    expect(got.callbacks).toHaveLength(1)
    const cb = got.callbacks[0]
    expect(cb.url).toBe('https://agent.example.com/act/decisions')
    const body = JSON.parse(cb.body)
    expect(body).toMatchObject({ event: 'action.decided', request_id: r.request_id, request_code: r.request_code,
      status: 'approved', may_proceed: true, decision_source: 'human', reason: 'Approved by Ravi Menon: Invoice checked', delivery_id: cb.id })
    expect(body.duplicate).toBeUndefined()
    expect(verify(cb, key)).toBe(true)
    expect(verify({ ...cb, body: cb.body.replace('approved', 'rejected') }, key)).toBe(false)
    expect(verify(cb, 'act_agt_someone_else')).toBe(false)
  })

  it('rejections are called back too, with may_proceed false', async () => {
    const { key } = await liveAgent()
    const r = await ask(key)
    await decide(r.request_id, 'reject', 'Unknown supplier')
    const body = JSON.parse((await claim(await latestToken())).callbacks[0].body)
    expect(body).toMatchObject({ status: 'rejected', may_proceed: false, reason: 'Rejected by Ravi Menon: Unknown supplier' })
  })

  it('no callback for requests decided at once by policy, or without a callback address', async () => {
    const { key } = await liveAgent()
    expect((await ask(key, 1000)).status).toBe('approved') // within limits: the agent already has its answer
    const r = await ask(key, 2_000_000, null)
    await decide(r.request_id, 'approve')
    expect((await db.query(`select 1 from public.callback_outbox`)).rows).toHaveLength(0)
  })

  it('a failed delivery is retried later, with growing gaps; success is recorded', async () => {
    const { key } = await liveAgent()
    const r = await ask(key)
    await decide(r.request_id, 'approve')
    let t = await latestToken()
    let cb = (await claim(t)).callbacks[0]
    await report(t, { callback: [{ id: cb.id, ok: false, status: 503, error: 'HTTP 503' }] })
    let row = (await db.query<{ sent_at: string | null; result: string; gap: number }>(
      `select sent_at, result, extract(epoch from next_attempt_at - now())::int gap from public.callback_outbox`)).rows[0]
    expect(row.sent_at).toBeNull()
    expect(row.result).toBe('Not delivered yet: HTTP 503 (will try again)')
    expect(row.gap).toBeGreaterThan(50)

    // Not due yet: the retry job leaves it; once due, it asks again.
    await db.query(`delete from net.calls`)
    await db.query(`select public.push_retry_due()`)
    expect((await db.query(`select 1 from net.calls`)).rows).toHaveLength(0)
    await db.query(`update public.callback_outbox set next_attempt_at = now() - interval '1 second', claimed_at = now() - interval '2 minutes'`)
    await db.query(`select public.push_retry_due()`)
    t = await latestToken()
    cb = (await claim(t)).callbacks[0]
    await report(t, { callback: [{ id: cb.id, ok: true, status: 200 }] })
    row = (await db.query<{ sent_at: string | null; result: string; gap: number }>(`select sent_at, result, 0 gap from public.callback_outbox`)).rows[0]
    expect(row.result).toBe('Delivered (HTTP 200)')
    expect(row.sent_at).not.toBeNull()
  })

  it('"who was told" shows the callback to the agent', async () => {
    const { key } = await liveAgent('Payments Bot')
    const r = await ask(key)
    await decide(r.request_id, 'approve')
    const t = await latestToken()
    const cb = (await claim(t)).callbacks[0]
    await report(t, { callback: [{ id: cb.id, ok: true, status: 204 }] })
    const told = await asUser(db, u.ravi, async (tx) =>
      (await tx.query<{ channel: string; person: string; status: string }>(`select channel, person, status from public.request_notifications($1)`, [r.request_id])).rows)
    expect(told.find((x) => x.channel === 'Callback to agent')).toEqual({ channel: 'Callback to agent', person: 'Payments Bot', status: 'Delivered (HTTP 204)' })
  })

  describe('agent console', () => {
    let demoAgent: string
    beforeAll(async () => {
      demoAgent = (await liveAgent('Payment Release Assistant')).id
    })

    const consoleAsk = (who: string, amount = 2_000_000, test = true) => asUser(db, who, async (tx) =>
      (await tx.query<{ r: { request_id: string; request_code: string; status: string } }>(
        `select public.demo_agent_ask($1, 'Hartwell Steel Ltd', 'Invoice HS-48817 is due today', $2) r`, [amount, test])).rows[0].r)
    const receive = (body: string, sig: string) => asRole(db, 'anon', async (tx) =>
      (await tx.query<{ r: string }>(`select public.demo_agent_receive($1, $2) r`, [body, sig])).rows[0].r)
    const events = async () => (await db.query<{ kind: string; status: string; may_proceed: boolean; reason: string }>(
      `select kind, status, may_proceed, reason from public.demo_agent_events order by id`)).rows

    it('only admins can use it', async () => {
      await expect(consoleAsk(u.ravi)).rejects.toThrow(/Only admins/)
    })

    it('asks as the agent with a callback to our receiver, and leaves no usable key behind', async () => {
      const r = await consoleAsk(u.admin)
      expect(r.status).toBe('pending')
      const row = (await db.query<{ callback_url: string; description: string; agent_id: string; revoked: boolean; test: string }>(
        `select r.callback_url, r.description, r.agent_id, k.revoked_at is not null revoked, r.details ->> 'test' test
           from public.action_requests r join public.agent_api_keys k on k.id = r.api_key_id where r.id = $1`, [r.request_id])).rows[0]
      expect(row).toEqual({ callback_url: `${SITE}/api/v1/demo-agent/callback`, description: 'Release £2,000,000 to supplier Hartwell Steel Ltd',
        agent_id: demoAgent, revoked: true, test: 'true' })
      expect((await events()).at(-1)).toMatchObject({ kind: 'asked', status: 'pending', may_proceed: false })
    })

    it('the receiver accepts the real signed callback once, and refuses a forged or old one', async () => {
      const r = await consoleAsk(u.admin)
      await decide(r.request_id, 'approve', 'Supplier verified')
      const cb = (await claim(await latestToken())).callbacks.find((c) => c.request_id === r.request_id)!
      expect(await receive(cb.body, cb.signature)).toBe('ok')
      expect(await receive(cb.body, cb.signature)).toBe('ok') // a retry of the same delivery is recorded once
      const heard = (await events()).filter((e) => e.kind === 'callback')
      expect(heard).toHaveLength(1)
      expect(heard[0]).toEqual({ kind: 'callback', status: 'approved', may_proceed: true, reason: 'Approved by Ravi Menon: Supplier verified' })

      await expect(receive(cb.body.replace('"approved"', '"rejected"'), cb.signature)).rejects.toThrow(/Signature does not match/)
      const old = `t=${Math.floor(Date.now() / 1000) - 600},v1=${cb.signature.split('v1=')[1]}`
      await expect(receive(cb.body, old)).rejects.toThrow(/Signature does not match/)
      await expect(receive('not json', cb.signature)).rejects.toThrow(/Signature does not match/)
    })

    it('admins read the console log; nobody else does', async () => {
      expect((await asUser(db, u.admin, async (tx) => (await tx.query(`select * from public.demo_agent_events`)).rows)).length).toBeGreaterThan(0)
      expect(await asUser(db, u.ravi, async (tx) => (await tx.query(`select * from public.demo_agent_events`)).rows)).toEqual([])
      await expect(asRole(db, 'anon', (tx) => tx.query(`select * from public.demo_agent_events`))).rejects.toThrow(/permission denied/)
      await expect(asRole(db, 'anon', (tx) => tx.query(`select * from public.callback_outbox`))).rejects.toThrow(/permission denied/)
      await expect(asRole(db, 'anon', (tx) => tx.query(`select public.push_claim_alerts_and_emails('x')`))).rejects.toThrow(/permission denied/)
    })
  })
})
