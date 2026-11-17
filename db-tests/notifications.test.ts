import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 5.4: an in-app notification alongside every email (R4.5). Done when: notification within 2 seconds (the
// browser test measures the time; here: every email makes one, for the right person, and only they can read it).
describe('in-app notifications (task 5.4)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.daniel = await createUser(db, 'daniel@bank.test', ['approver'], 'Daniel Okafor')
    await grantScope(db, u.ravi, payments)
    await grantScope(db, u.daniel, payments)
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
    await db.query(`select public.email_configure('re_test_key', null, 'inbox@company.example')`)
  })

  async function liveAgent(name: string, data = '{internal}', extra: Record<string, unknown> = {}) {
    const id = await proposeAgent(db, u.james, { name, department_id: payments, risk_tier: 'high', ...extra })
    await db.query(`update public.agents set data_classifications = $2::public.data_classification[] where id = $1`, [id, data])
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    return id
  }
  const mine = (who: string) => asUser(db, who, async (tx) => (await tx.query<{ id: number; kind: string; event: string | null; title: string; body: string; url: string; pii: boolean; read_at: string | null }>(
    `select id, kind, event, title, body, url, pii, read_at from public.notifications order by id`)).rows)

  it('every email makes a notification for its person, even one that is not sent', async () => {
    const id = await liveAgent('Invoice Matcher', '{personal}')
    await db.query(`select public.alert_email_mode('test_inbox')`)
    await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Wrong matches')`, [id]))
    const emails = (await db.query<{ id: number; user_id: string }>(`select id, user_id from public.email_outbox where agent_id = $1 and event = 'suspended'`, [id])).rows
    const notes = (await db.query<{ email_id: number; user_id: string }>(`select email_id, user_id from public.notifications where agent_id = $1 and event = 'suspended'`, [id])).rows
    expect(notes.map((n) => `${n.email_id}:${n.user_id}`).sort()).toEqual(emails.map((e) => `${e.id}:${e.user_id}`).sort())
    const [n] = (await mine(u.james)).filter((x) => x.event === 'suspended')
    expect(n).toMatchObject({ kind: 'alert', title: expect.stringMatching(/^Personal data · Suspended · AGT-\d{4}$/), url: `/agents/${id}`, pii: true, read_at: null })
    expect(n.body).toMatch(/Invoice Matcher was suspended$/)
    await db.query(`select public.alert_email_mode('send')`)
  })

  it('approval requests and switch-back-on requests too, linking to their task', async () => {
    const id = await liveAgent('Payment Release Assistant', '{internal}', { autonomy_level: 3, value_threshold: 250000, threshold_currency: 'GBP' })
    const key = await asUser(db, u.james, async (tx) => (await tx.query<{ k: string }>(`select public.create_agent_api_key($1) k`, [id])).rows[0].k)
    await asRole(db, 'anon', (tx) => tx.query(`select public.api_request_action($1, $2::jsonb)`, [key, JSON.stringify({
      idempotency_key: 'n1', action: 'payment.release', amount: 2_000_000, currency: 'GBP',
      description: 'Release £2,000,000 to supplier Hartwell Steel Ltd', reasoning: 'Invoice HS-48817 is due today' })]))
    const approval = (await mine(u.ravi)).find((x) => x.kind === 'new')!
    expect(approval.title).toMatch(/^Approval needed · REQ-\d{6}$/)
    expect(approval.url).toMatch(/^\/approvals\/requests\/[0-9a-f-]{36}$/)

    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'suspended' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    await db.query(`update public.incidents set status = 'contained', containment = 'x' where agent_id = $1`, [id])
    const r = await asUser(db, u.james, async (tx) => (await tx.query<{ r: string }>(`select public.request_reactivation($1, 'Fixed') r`, [id])).rows[0].r)
    const ask = (await mine(u.daniel)).find((x) => x.kind === 'reactivation')!
    expect(ask).toMatchObject({ title: expect.stringMatching(/^Switch back on\? · AGT-\d{4}$/), url: `/approvals/reactivations/${r}`,
      body: 'James Whitfield asks to switch Payment Release Assistant back on: Fixed' })
  })

  it('people read only their own; marking read works for their own only', async () => {
    const theirs = await mine(u.ravi)
    expect(theirs.length).toBeGreaterThan(0)
    expect((await mine(u.daniel)).every((n) => !theirs.some((t) => t.id === n.id))).toBe(true)
    const one = theirs[0].id
    expect(await asUser(db, u.daniel, async (tx) => (await tx.query<{ n: number }>(`select public.mark_notifications_read($1::bigint[]) n`, [[one]])).rows[0].n)).toBe(0)
    expect(await asUser(db, u.ravi, async (tx) => (await tx.query<{ n: number }>(`select public.mark_notifications_read($1::bigint[]) n`, [[one]])).rows[0].n)).toBe(1)
    expect((await mine(u.ravi)).find((n) => n.id === one)!.read_at).not.toBeNull()
    await asUser(db, u.ravi, (tx) => tx.query(`select public.mark_notifications_read()`))
    expect((await mine(u.ravi)).every((n) => n.read_at !== null)).toBe(true)
    await expect(asUser(db, u.ravi, (tx) => tx.query(`update public.notifications set read_at = null`))).rejects.toThrow(/permission denied/)
  })

  it('phone alerts for alert events follow the alert routes, like the emails; the retired fixed alerts no longer appear', async () => {
    const id = await liveAgent('Statement Bot')
    await asUser(db, u.admin, (tx) => tx.query(`insert into public.alert_routes (name, scope, department_id, events, people)
      values ('Payments risk', 'department', $1, '{suspended}', $2::uuid[])`, [payments, [u.daniel]]))
    await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Odd results')`, [id]))
    const pushes = (await db.query<{ user_id: string }>(`select user_id from public.push_outbox where kind = 'alert' and url = $1 and title like '%Suspended%'`, [`/agents/${id}`])).rows
    expect(pushes.map((p) => p.user_id)).toEqual([u.daniel])
    await db.query(`insert into public.push_outbox (user_id, kind, title, body, url) values ($1, 'data_authority', 'No authority · x', 'x', '/agents')`, [u.admin])
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.push_outbox where kind = 'data_authority'`)).rows[0].n).toBe(0)
  })
})
