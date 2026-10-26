import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 2.7: approval emails. Queued for the same people as phone alerts, sent through the same dispatch.
describe('approval emails (task 2.7)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  const SITE = 'https://main.example.pages.dev'

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'])
    u.owner = await createUser(db, 'owner@bank.test', ['owner'], 'Owen Owner')
    u.ravi = await createUser(db, 'ravi.menon@northbridge.demo', ['approver'], 'Ravi Menon')
    u.daniel = await createUser(db, 'daniel.okafor@northbridge.demo', ['approver'], 'Daniel Okafor')
    u.outsider = await createUser(db, 'outsider@bank.test', ['approver'], 'Olu Outsider')
    for (const p of [u.ravi, u.daniel]) await grantScope(db, p, payments)
    await db.query(`update public.profiles set email = $2 where id = $1`, [u.ravi, 'ravi.menon@northbridge.demo'])
    await db.query(`update public.profiles set email = $2 where id = $1`, [u.daniel, 'daniel.okafor@northbridge.demo'])
    await db.query(`select public.push_configure($1)`, [SITE]) // site only: no alert keys
    await asUser(db, u.admin, (tx) => tx.query(
      `insert into public.routing_rules (name, priority, min_amount, currency, approver_id) values ('Large', 10, 1000000, 'GBP', $1)`, [u.ravi]))
  })

  beforeEach(async () => {
    await db.query(`delete from public.email_outbox`)
    await db.query(`delete from public.push_outbox`)
    await db.query(`delete from net.calls`)
    await db.query(`select public.email_configure('re_test_key', null, 'inbox@company.example')`)
  })

  async function liveAgent() {
    const id = await proposeAgent(db, u.owner, { name: `Payment Release Assistant ${crypto.randomUUID().slice(0, 6)}`,
      department_id: payments, autonomy_level: 3, value_threshold: 250000, threshold_currency: 'GBP' })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    return asUser(db, u.owner, async (tx) => (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
  }

  const ask = async (key: string, details: Record<string, unknown> = {}) =>
    asRole(db, 'anon', async (tx) =>
      (await tx.query<{ r: { request_id: string; status: string; request_code: string } }>(`select public.api_request_action($1, $2::jsonb) r`, [key, JSON.stringify({
        idempotency_key: crypto.randomUUID(), action: 'payment.release', amount: 2_000_000, currency: 'GBP',
        description: 'Release £2,000,000 to supplier Hartwell Steel Ltd', reasoning: 'Invoice HS-48817 is due today', details,
      })])).rows[0].r)

  const token = async () => (await db.query<{ t: string }>(`select body ->> 'token' t from net.calls order by id desc limit 1`)).rows[0].t
  type Claimed = { email?: { api_key: string; from: string; redirect_to: string; site_url: string }; emails: { id: number; kind: string; test: boolean; to_name: string; to_email: string; request: Record<string, unknown> }[] }
  const claim = async (t: string) => asRole(db, 'anon', async (tx) => (await tx.query<{ r: Claimed }>(`select public.push_claim($1) r`, [t])).rows[0].r)
  const report = (t: string, results: unknown) => asRole(db, 'anon', (tx) => tx.query(`select public.push_report($1, $2::jsonb)`, [t, JSON.stringify(results)]))
  const told = (who: string, requestId: string) => asUser(db, who, async (tx) =>
    (await tx.query<{ channel: string; person: string; status: string }>(`select channel, person, status from public.request_notifications($1)`, [requestId])).rows)

  it('emails the assigned approver; the sender gets what it needs to write the email', async () => {
    const r = await ask(await liveAgent())
    const calls = await db.query(`select 1 from net.calls`)
    expect(calls.rows).toHaveLength(1) // alerts and email ride on one call
    const got = await claim(await token())
    expect(got.email).toEqual({ api_key: 're_test_key', from: 'Agent Control Tower <onboarding@resend.dev>', redirect_to: 'inbox@company.example', site_url: SITE })
    expect(got.emails).toHaveLength(1)
    expect(got.emails[0]).toMatchObject({ kind: 'new', test: false, to_name: 'Ravi Menon', to_email: 'ravi.menon@northbridge.demo' })
    expect(got.emails[0].request).toMatchObject({ id: r.request_id, code: r.request_code, reasoning: 'Invoice HS-48817 is due today',
      amount: 2000000, currency: 'GBP' })
    expect(got.emails[0].request.headline).toMatch(/ wants to release £2,000,000 to supplier Hartwell Steel Ltd$/)
    expect(String(got.emails[0].request.hold_reason)).toMatch(/outside its limits/)
  })

  it('records the result, and shows "who was told" to people who can see the request', async () => {
    const r = await ask(await liveAgent())
    const t = await token()
    const got = await claim(t)
    await report(t, { push: [], email: [{ id: got.emails[0].id, sent: true, provider_id: 'em_123', sent_to: 'inbox@company.example' }] })
    expect(await told(u.ravi, r.request_id)).toEqual([
      { channel: 'Phone alert', person: 'Ravi Menon', status: 'Sending…' }, // no alert keys in this test, so never claimed
      { channel: 'Email', person: 'Ravi Menon', status: 'Sent (demo inbox)' },
    ])
    // Someone who cannot see the agent learns nothing.
    expect(await told(u.outsider, r.request_id)).toEqual([])
  })

  it('emails the new approver on escalation, with who escalated and why', async () => {
    const r = await ask(await liveAgent())
    await claim(await token())
    await asUser(db, u.ravi, (tx) => tx.query(`select public.escalate_action_request($1, $2, 'New supplier')`, [r.request_id, u.daniel]))
    const got = await claim(await token())
    expect(got.emails.map((e) => [e.to_name, e.kind])).toEqual([['Daniel Okafor', 'escalated']])
    expect(got.emails[0].request).toMatchObject({ escalated_by: 'Ravi Menon', escalation_reason: 'New supplier' })
  })

  it('marks test requests so the sender uses the test inbox', async () => {
    await ask(await liveAgent(), { test: true })
    const got = await claim(await token())
    expect(got.emails[0].test).toBe(true)
  })

  it('retries an email that failed for a passing reason; finishes one that cannot succeed', async () => {
    await ask(await liveAgent())
    await ask(await liveAgent())
    const t = await token()
    const got = await claim(t)
    const [a, b] = got.emails.map((e) => e.id)
    await report(t, { email: [
      { id: a, sent: false, error: '429 from Resend: too many requests', retry: true },
      { id: b, sent: false, error: '403 from Resend: testing emails go only to your own address', retry: false },
    ] })
    const rows = (await db.query<{ id: number; sent_at: string | null; result: string }>(`select id, sent_at, result from public.email_outbox order by id`)).rows
    expect(rows[0]).toMatchObject({ sent_at: null, result: 'Not sent: 429 from Resend: too many requests' })
    expect(rows[1].sent_at).not.toBeNull()
    // The retry job picks the first one up again after a minute.
    await db.query(`delete from net.calls`)
    await db.query(`update public.email_outbox set claimed_at = now() - interval '2 minutes'`)
    await db.query(`select public.push_retry_due()`)
    expect((await db.query(`select 1 from net.calls`)).rows).toHaveLength(1)
  })

  it('does not email about a request that was decided before the email went out', async () => {
    const r = await ask(await liveAgent())
    const t = await token()
    await asUser(db, u.ravi, (tx) => tx.query(`select public.decide_action_request($1, 'approve', null)`, [r.request_id]))
    const got = await claim(t)
    expect(got.emails).toEqual([])
    const row = (await db.query<{ result: string }>(`select result from public.email_outbox`)).rows[0]
    expect(row.result).toBe('Not sent: already approved')
  })

  it('without an API key, emails are closed as "not set up yet" (and the old alert report format still works)', async () => {
    await db.query(`select public.email_configure('', null, null)`)
    const r = await ask(await liveAgent())
    const t = await token()
    const got = await claim(t)
    expect(got.email).toBeUndefined()
    await report(t, []) // the task 2.6 sender reports a plain list
    expect((await told(u.ravi, r.request_id)).find((x) => x.channel === 'Email')?.status).toBe('Not sent: email is not set up yet')
    // The redirect inbox is kept when not given again.
    expect((await db.query<{ r: string }>(`select email_redirect_to r from public.push_config`)).rows[0].r).toBe('inbox@company.example')
  })

  it('keeps the email settings and queue away from everyone', async () => {
    await expect(asUser(db, u.admin, (tx) => tx.query(`select * from public.email_outbox`))).rejects.toThrow(/permission denied/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select email_api_key from public.push_config`))).rejects.toThrow(/permission denied/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.email_configure('x', null, null)`))).rejects.toThrow(/permission denied/)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select * from public.request_notifications(gen_random_uuid())`))).rejects.toThrow(/permission denied/)
  })
})
