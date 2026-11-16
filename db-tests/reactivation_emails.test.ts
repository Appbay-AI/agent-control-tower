import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 5.3: emails link to the reactivation approval task; a reply email is never a decision (R4.4).
// Done when: decision only through the app.
describe('reactivation emails (task 5.3)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    const hr = await createDepartment(db, 'HR')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.admin2 = await createUser(db, 'admin2@bank.test', ['admin'], 'Second Admin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.omar = await createUser(db, 'omar@bank.test', ['approver'], 'Omar Farouk')
    u.gone = await createUser(db, 'gone@bank.test', ['approver'], 'Gone Approver')
    await grantScope(db, u.ravi, payments)
    await grantScope(db, u.gone, payments)
    await grantScope(db, u.omar, hr)
    await db.query(`update public.profiles set is_active = false where id = $1`, [u.gone])
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
    await db.query(`select public.email_configure('re_test_key', null, 'inbox@company.example')`)
  })

  async function suspendedAgent(critical = false) {
    const id = await proposeAgent(db, u.james, { name: `Agent ${crypto.randomUUID().slice(0, 6)}`, department_id: payments, risk_tier: critical ? 'critical' : 'high' })
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`update public.agents set status = 'suspended' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    await db.query(`update public.incidents set status = 'contained', containment = 'Suspended' where agent_id = $1`, [id])
    return id
  }
  const ask = (id: string) => asUser(db, u.james, async (tx) => (await tx.query<{ r: string }>(`select public.request_reactivation($1, 'Fix deployed and tested') r`, [id])).rows[0].r)
  const emails = async (r: string) => (await db.query<{ name: string; kind: string; result: string | null }>(
    `select p.full_name name, e.kind, e.result from public.email_outbox e join public.profiles p on p.id = e.user_id
      where e.reactivation_id = $1 order by e.id`, [r])).rows
  const token = async () => (await db.query<{ t: string }>(`select body ->> 'token' t from net.calls where url like '%/push/dispatch' order by id desc limit 1`)).rows[0].t
  type Claimed = { emails: { kind: string; to_name: string; reactivation?: Record<string, any> }[] }
  // The token is read first: reading it inside the anon transaction would wait on that transaction forever.
  const claim = async () => { const t = await token(); return asRole(db, 'anon', async (tx) => (await tx.query<{ r: Claimed }>(`select public.push_claim($1) r`, [t])).rows[0].r) }

  it('asked: everyone who may approve is emailed (admins and the department\'s approvers), never the asker or the inactive', async () => {
    const id = await suspendedAgent()
    const r = await ask(id)
    expect((await emails(r)).map((e) => `${e.name} ${e.kind}`).sort()).toEqual(['Platform Admin reactivation', 'Ravi Menon reactivation', 'Second Admin reactivation'])
    // The phone alert opens the task too.
    const push = (await db.query<{ url: string }>(`select url from public.push_outbox where kind = 'reactivation' and title like 'Switch back on? ·%' order by id desc limit 1`)).rows[0]
    expect(push.url).toBe(`/approvals/reactivations/${r}`)
  })

  it('the sender gets the request with what the approver needs; the link is the task in the app', async () => {
    await db.query(`delete from public.email_outbox`)
    await db.query(`delete from net.calls`)
    const id = await suspendedAgent()
    const r = await ask(id)
    const mine = (await claim()).emails.filter((e) => e.reactivation?.id === r)
    expect(mine).toHaveLength(3)
    expect(mine[0].reactivation).toMatchObject({ reason: 'Fix deployed and tested', asked_by: 'James Whitfield', required: 1, approved_by: [],
      agent: { id, risk_tier: 'high', department: 'Payments' }, incidents: [expect.objectContaining({ status: 'contained' })] })
  })

  it('Critical: after the first approval the others get "second approval needed"; the first approver does not', async () => {
    const id = await suspendedAgent(true)
    const r = await ask(id)
    await asUser(db, u.ravi, (tx) => tx.query(`select public.approve_reactivation($1, 'Checked')`, [r]))
    const second = (await emails(r)).filter((e) => e.kind === 'reactivation_second').map((e) => e.name).sort()
    expect(second).toEqual(['Platform Admin', 'Second Admin'])
  })

  it('decided before the email went out: not sent', async () => {
    await db.query(`delete from net.calls`)
    const id = await suspendedAgent()
    const r = await ask(id)
    await asUser(db, u.ravi, (tx) => tx.query(`select public.approve_reactivation($1, 'Checked')`, [r]))
    await claim()
    expect((await emails(r)).map((e) => e.result)).toEqual(['Not sent: already approved', 'Not sent: already approved', 'Not sent: already approved'])
  })

  it('decisions only in the app: nobody signed out can approve, reject or read the request', async () => {
    const id = await suspendedAgent()
    const r = await ask(id)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select public.approve_reactivation($1, null)`, [r]))).rejects.toThrow(/permission denied/)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select public.reject_reactivation($1, 'no')`, [r]))).rejects.toThrow(/permission denied/)
    await expect(asRole(db, 'anon', (tx) => tx.query(`select * from public.agent_reactivations`))).rejects.toThrow(/permission denied/)
    // Someone outside the department cannot approve either, even with the task's address.
    await expect(asUser(db, u.omar, (tx) => tx.query(`select public.approve_reactivation($1, null)`, [r]))).rejects.toThrow(/Only admins and approvers/)
  })

  it('who was told, on the task page; not for people who cannot see the agent', async () => {
    const id = await suspendedAgent()
    const r = await ask(id)
    const told = await asUser(db, u.ravi, async (tx) => (await tx.query<{ channel: string; person: string }>(
      `select channel, person from public.reactivation_notifications($1)`, [r])).rows)
    expect(told.filter((x) => x.channel === 'Email').map((x) => x.person).sort()).toEqual(['Platform Admin', 'Ravi Menon', 'Second Admin'])
    expect(told.some((x) => x.channel === 'Phone alert')).toBe(true)
    expect(await asUser(db, u.omar, async (tx) => (await tx.query(`select * from public.reactivation_notifications($1)`, [r])).rows)).toEqual([])
  })
})
