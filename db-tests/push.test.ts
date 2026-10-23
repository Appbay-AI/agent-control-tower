import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 2.6: phone alerts. Who is alerted, the one-time dispatch token, claiming and reporting, and who may do what.
describe('phone alerts (task 2.6)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  const SITE = 'https://main.example.pages.dev'
  const JWK = { kty: 'EC', crv: 'P-256', d: 'secret-d', x: 'x', y: 'y' }
  const PUB = 'B' + 'A'.repeat(86)

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    const lending = await createDepartment(db, 'Lending')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'])
    u.owner = await createUser(db, 'owner@bank.test', ['owner'], 'Owen Owner')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.daniel = await createUser(db, 'daniel@bank.test', ['approver'], 'Daniel Okafor')
    u.outsider = await createUser(db, 'outsider@bank.test', ['approver'], 'Olu Outsider')
    u.approverOwner = await createUser(db, 'approver.owner@bank.test', ['approver', 'owner'], 'Olly Owner')
    u.gone = await createUser(db, 'gone@bank.test', ['approver'], 'Gina Gone')
    for (const p of [u.ravi, u.daniel, u.approverOwner, u.gone]) await grantScope(db, p, payments)
    await grantScope(db, u.outsider, lending)
    await db.query(`update public.profiles set is_active = false where id = $1`, [u.gone])
    await db.query(`select public.push_configure($1, $2, $3::jsonb, null)`, [SITE, PUB, JSON.stringify(JWK)])
  })

  beforeEach(async () => {
    await db.query(`delete from public.routing_rules`)
    await db.query(`delete from public.push_outbox`)
    await db.query(`delete from net.calls`)
  })

  async function liveAgent(owner = u.approverOwner) {
    const id = await proposeAgent(db, owner, { name: `Payment Release Assistant ${crypto.randomUUID().slice(0, 6)}`,
      department_id: payments, autonomy_level: 3, value_threshold: 250000, threshold_currency: 'GBP' })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    const key = await asUser(db, owner, async (tx) =>
      (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
    return { id, key }
  }

  const ask = async (key: string, amount: number, description = 'Release £2,000,000 to supplier Hartwell Steel Ltd') =>
    asRole(db, 'anon', async (tx) =>
      (await tx.query<{ r: { request_id: string; status: string; request_code: string } }>(`select public.api_request_action($1, $2::jsonb) r`, [key, JSON.stringify({
        idempotency_key: crypto.randomUUID(), action: 'payment.release', amount, currency: 'GBP', description,
      })])).rows[0].r)

  const outbox = async () => (await db.query<{ user_id: string; title: string; body: string; url: string; kind: string }>(
    `select user_id, title, body, url, kind from public.push_outbox order by id`)).rows

  const subscribe = (who: string, n = 1) => asUser(db, who, async (tx) =>
    (await tx.query<{ id: string }>(`select public.push_subscribe($1, $2, $3, 'Pixel 7 · Chrome') id`,
      [`https://fcm.googleapis.com/fcm/send/${who}-${n}`, 'B' + 'p'.repeat(86), 'a'.repeat(22)])).rows[0].id)

  const kicks = async () => (await db.query<{ url: string; token: string }>(`select url, body ->> 'token' token from net.calls order by id`)).rows

  const claim = (token: string) => asRole(db, 'anon', async (tx) =>
    (await tx.query<{ r: { vapid?: Record<string, unknown>; messages: { id: number; title: string; subscriptions: { id: string; endpoint: string }[] }[] } }>(
      `select public.push_claim($1) r`, [token])).rows[0].r)
  const report = (token: string, results: unknown) => asRole(db, 'anon', async (tx) =>
    (await tx.query(`select public.push_report($1, $2::jsonb)`, [token, JSON.stringify(results)])).rows)

  it('alerts the assigned approver with what the agent wants, and links to the task', async () => {
    await asUser(db, u.admin, (tx) => tx.query(
      `insert into public.routing_rules (name, priority, min_amount, currency, approver_id) values ('Large', 10, 1000000, 'GBP', $1)`, [u.ravi]))
    const { key } = await liveAgent()
    const r = await ask(key, 2_000_000)
    const rows = await outbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: u.ravi, kind: 'action_request', url: `/approvals/requests/${r.request_id}`,
      title: `Approval needed · ${r.request_code}` })
    expect(rows[0].body).toMatch(/^Payment Release Assistant \w+ wants to release £2,000,000 to supplier Hartwell Steel Ltd$/)
  })

  it('with no rule, alerts every active department approver except the agent\'s owner', async () => {
    const { key } = await liveAgent(u.approverOwner)
    await ask(key, 2_000_000)
    expect((await outbox()).map((o) => o.user_id).sort()).toEqual([u.ravi, u.daniel].sort())
  })

  it('alerts nobody for actions that need no person', async () => {
    const { key } = await liveAgent()
    expect((await ask(key, 1000)).status).toBe('approved')
    expect(await outbox()).toHaveLength(0)
    expect(await kicks()).toHaveLength(0)
  })

  it('alerts the new approver when a request is escalated', async () => {
    await asUser(db, u.admin, (tx) => tx.query(
      `insert into public.routing_rules (name, priority, min_amount, currency, approver_id) values ('Large', 10, 1000000, 'GBP', $1)`, [u.ravi]))
    const { key } = await liveAgent()
    const r = await ask(key, 2_000_000)
    await asUser(db, u.ravi, (tx) => tx.query(`select public.escalate_action_request($1, $2, 'New supplier')`, [r.request_id, u.daniel]))
    const rows = await outbox()
    expect(rows.map((o) => o.user_id)).toEqual([u.ravi, u.daniel])
    expect(rows[1].title).toBe(`Escalated to you · ${r.request_code}`)
  })

  it('asks the site to send once per batch, with a one-time token', async () => {
    const { key } = await liveAgent(u.approverOwner)
    await ask(key, 2_000_000) // two approvers, one call
    const calls = await kicks()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${SITE}/api/v1/push/dispatch`)
    expect(calls[0].token).toMatch(/^pdt_[0-9a-f]{64}$/)
    // Only the hash is stored.
    const stored = await db.query(`select 1 from public.push_dispatch_tokens where token_hash = $1`, [calls[0].token])
    expect(stored.rows).toHaveLength(0)
  })

  it('the token claims the waiting alerts with the signing key; it works once, and a made-up one never', async () => {
    const ravi = await subscribe(u.ravi)
    const { key } = await liveAgent(u.approverOwner)
    await ask(key, 2_000_000) // Ravi has a device; Daniel has none
    const [{ token }] = await kicks()

    await expect(claim('pdt_' + 'f'.repeat(64))).rejects.toThrow(/Invalid or used dispatch token/)
    const got = await claim(token)
    expect(got.vapid).toMatchObject({ public_key: PUB, private_jwk: JWK, subject: SITE })
    expect(got.messages).toHaveLength(1)
    expect(got.messages[0].subscriptions.map((s) => s.id)).toEqual([ravi])
    await expect(claim(token)).rejects.toThrow(/Invalid or used dispatch token/)

    // Daniel's alert is closed at once: no device.
    const daniel = await db.query<{ sent_at: string | null; result: string }>(`select sent_at, result from public.push_outbox where user_id = $1`, [u.daniel])
    expect(daniel.rows[0]).toMatchObject({ result: 'No device has alerts switched on' })
    expect(daniel.rows[0].sent_at).not.toBeNull()

    // The report finishes Ravi's alert and can be sent once.
    await report(token, [{ id: got.messages[0].id, delivered: [ravi], gone: [], failed: [] }])
    const done = await db.query<{ result: string; devices_reached: number }>(`select result, devices_reached from public.push_outbox where user_id = $1`, [u.ravi])
    expect(done.rows[0]).toEqual({ result: 'Sent to 1 device(s)', devices_reached: 1 })
    await expect(report(token, [])).rejects.toThrow(/Invalid or used dispatch token/)
    await db.query(`delete from public.push_subscriptions`)
  })

  it('removes devices the push service says are gone, and retries ones that failed', async () => {
    const phone = await subscribe(u.ravi, 1)
    const laptop = await subscribe(u.ravi, 2)
    await asUser(db, u.ravi, (tx) => tx.query(`select public.push_send_test()`))
    const [{ token }] = await kicks()
    const got = await claim(token)
    await report(token, [{ id: got.messages[0].id, delivered: [], gone: [phone], failed: [{ id: laptop, error: '503 from push service' }] }])
    const subs = await db.query<{ id: string; last_error: string }>(`select id, last_error from public.push_subscriptions`)
    expect(subs.rows).toEqual([{ id: laptop, last_error: '503 from push service' }])
    const o = await db.query<{ sent_at: string | null; result: string; attempts: number }>(`select sent_at, result, attempts from public.push_outbox`)
    expect(o.rows[0]).toMatchObject({ sent_at: null, attempts: 1, result: 'Not sent: 503 from push service' })

    // The retry job asks again once a minute has passed.
    await db.query(`delete from net.calls`)
    await db.query(`select public.push_retry_due()`)
    expect(await kicks()).toHaveLength(0)
    await db.query(`update public.push_outbox set claimed_at = now() - interval '2 minutes'`)
    await db.query(`select public.push_retry_due()`)
    expect(await kicks()).toHaveLength(1)
    await db.query(`delete from public.push_subscriptions`)
  })

  it('people manage only their own devices; test alerts need a device', async () => {
    await expect(asUser(db, u.daniel, (tx) => tx.query(`select public.push_send_test()`))).rejects.toThrow(/Turn alerts on for this device first/)
    await subscribe(u.daniel)
    await asUser(db, u.daniel, (tx) => tx.query(`select public.push_send_test()`))
    await expect(asUser(db, u.daniel, (tx) => tx.query(`select public.push_send_test()`))).rejects.toThrow(/already on its way/)
    expect((await outbox()).map((o) => [o.user_id, o.kind, o.url])).toEqual([[u.daniel, 'test', '/approvals']])

    // Ravi sees only his own devices, and can't remove Daniel's.
    const seen = await asUser(db, u.ravi, async (tx) => (await tx.query(`select id from public.push_subscriptions`)).rows)
    expect(seen).toHaveLength(0)
    await asUser(db, u.ravi, (tx) => tx.query(`select public.push_unsubscribe($1)`, [`https://fcm.googleapis.com/fcm/send/${u.daniel}-1`]))
    expect((await db.query(`select 1 from public.push_subscriptions`)).rows).toHaveLength(1)
    await asUser(db, u.daniel, (tx) => tx.query(`select public.push_unsubscribe($1)`, [`https://fcm.googleapis.com/fcm/send/${u.daniel}-1`]))
    expect((await db.query(`select 1 from public.push_subscriptions`)).rows).toHaveLength(0)

    await expect(asUser(db, u.ravi, (tx) => tx.query(`select public.push_subscribe('http://insecure.example/x', $1, $2)`,
      ['B' + 'p'.repeat(86), 'a'.repeat(22)]))).rejects.toThrow()
  })

  it('keeps the signing key and the queue away from everyone; only the public key is readable', async () => {
    expect(await asUser(db, u.ravi, async (tx) => (await tx.query<{ k: string }>(`select public.push_public_key() k`)).rows[0].k)).toBe(PUB)
    for (const t of ['push_config', 'push_outbox', 'push_dispatch_tokens']) {
      await expect(asUser(db, u.admin, (tx) => tx.query(`select * from public.${t}`)), t).rejects.toThrow(/permission denied/)
      await expect(asRole(db, 'anon', (tx) => tx.query(`select * from public.${t}`)), t).rejects.toThrow(/permission denied/)
    }
    await expect(asRole(db, 'anon', (tx) => tx.query(`select * from public.push_subscriptions`))).rejects.toThrow(/permission denied/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.push_configure('https://evil.example', 'x', '{}'::jsonb, null)`)))
      .rejects.toThrow(/permission denied/)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select public.push_send_test()`))).rejects.toThrow(/permission denied/)
  })

  it('new keys remove old devices; the migration runs again safely', async () => {
    await subscribe(u.ravi)
    await db.query(`select public.push_configure($1)`, [SITE]) // site URL only: devices kept
    expect((await db.query(`select 1 from public.push_subscriptions`)).rows).toHaveLength(1)
    await db.query(`select public.push_configure($1, $2, $3::jsonb, null)`, [SITE, 'B' + 'C'.repeat(86), JSON.stringify(JWK)])
    expect((await db.query(`select 1 from public.push_subscriptions`)).rows).toHaveLength(0)
    await db.query(`select public.push_configure($1, $2, $3::jsonb, null)`, [SITE, PUB, JSON.stringify(JWK)])
    // The cron block and extension checks are skipped here (no pg_cron/pg_net in PGlite) and must not fail.
    const sql = readFileSync(path.resolve(__dirname, '../supabase/migrations/20261024000100_push_alerts.sql'), 'utf8')
    expect(sql).toContain("cron.schedule('push-retry'")
  })
})
