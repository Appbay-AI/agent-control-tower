import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 5.2: alert routing (R4.3). Done when: changing a route needs no deploy.
// For an event on an agent: its agent routes, else its department's routes, else the default route.
describe('alert routing (task 5.2)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let hr: string
  const agents: Record<string, string> = {}

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    hr = await createDepartment(db, 'HR')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.cro = await createUser(db, 'cro@bank.test', ['executive'], 'Priya Sharma')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.tech = await createUser(db, 'tech@bank.test', ['owner'], 'Tara Tech')
    u.daniel = await createUser(db, 'daniel@bank.test', ['approver'], 'Daniel Okafor')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    await grantScope(db, u.daniel, payments)
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
    await db.query(`select public.email_configure('re_test_key', null, 'inbox@company.example')`)
    agents.pay = await proposeAgent(db, u.james, { name: 'Invoice Matcher', department_id: payments })
    agents.pay2 = await proposeAgent(db, u.james, { name: 'Payment Release Assistant', department_id: payments })
    agents.hr = await proposeAgent(db, u.james, { name: 'Rota Planner', department_id: hr })
    await db.query(`update public.agents set technical_owner_id = $1 where id = $2`, [u.tech, agents.pay])
  })

  const who = async (agent: string, event: string) => (await db.query<{ name: string; because: string }>(
    `select p.full_name name, r.because from public.alert_recipients($1, $2) r join public.profiles p on p.id = r.user_id order by 1`, [agent, event])).rows
  const names = async (agent: string, event: string) => (await who(agent, event)).map((x) => x.name)
  const admin = <T>(sql: string, params: unknown[] = []) => asUser(db, u.admin, async (tx) => (await tx.query<T>(sql, params)).rows)
  const addRoute = async (route: Record<string, unknown>) => (await admin<{ id: string }>(
    `insert into public.alert_routes (name, scope, department_id, agent_id, events, to_admins, to_business_owner, to_technical_owner, people, also_default)
     values ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9::uuid[], $10) returning id`,
    [route.name, route.scope, route.department_id ?? null, route.agent_id ?? null, route.events ?? [], route.to_admins ?? false,
      route.to_business_owner ?? false, route.to_technical_owner ?? false, route.people ?? [], route.also_default ?? false]))[0].id

  it('starts as task 5.1 behaved: every admin and the business owner, with the reason each is told', async () => {
    expect(await who(agents.pay, 'suspended')).toEqual([
      { name: 'James Whitfield', because: 'You are the business owner of Invoice Matcher.' },
      { name: 'Platform Admin', because: 'You are an admin of Agent Control Tower.' },
    ])
  })

  it('a designated person on the default route gets every event', async () => {
    await admin(`update public.alert_routes set people = $1::uuid[] where scope = 'default'`, [[u.ravi]])
    expect(await names(agents.hr, 'discovered')).toEqual(['James Whitfield', 'Platform Admin', 'Ravi Menon'])
    expect((await who(agents.hr, 'discovered')).find((x) => x.name === 'Ravi Menon')!.because).toBe('You are named on the alert route "Default".')
  })

  it('a department route replaces the default for its events and department only; changing it applies to the next event', async () => {
    const id = await addRoute({ name: 'Payments risk', scope: 'department', department_id: payments, events: ['suspended'], people: [u.daniel] })
    expect(await names(agents.pay, 'suspended')).toEqual(['Daniel Okafor'])
    expect(await names(agents.pay, 'discovered')).toEqual(['James Whitfield', 'Platform Admin', 'Ravi Menon']) // other events: default
    expect(await names(agents.hr, 'suspended')).toEqual(['James Whitfield', 'Platform Admin', 'Ravi Menon']) // other departments: default

    // No deploy: an admin ticks "also the default route", and the next email follows it.
    await admin(`update public.alert_routes set also_default = true where id = $1`, [id])
    expect(await names(agents.pay, 'suspended')).toEqual(['Daniel Okafor', 'James Whitfield', 'Platform Admin', 'Ravi Menon'])
    // The queued email says why each person got it, and which route.
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [agents.pay])
    await db.query(`update public.agents set status = 'live' where id = $1`, [agents.pay])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Wrong matches')`, [agents.pay]))
    const queued = (await db.query<{ name: string; because: string; route: string }>(
      `select p.full_name name, e.details ->> 'because' because, e.details ->> 'route' route from public.email_outbox e
         join public.profiles p on p.id = e.user_id where e.agent_id = $1 and e.event = 'suspended' order by 1`, [agents.pay])).rows
    expect(queued.find((x) => x.name === 'Daniel Okafor')).toEqual({ name: 'Daniel Okafor', because: 'You are named on the alert route "Payments risk".', route: 'Payments risk' })
    expect(queued).toHaveLength(4)

    // Switched off: back to the default.
    await admin(`update public.alert_routes set is_active = false where id = $1`, [id])
    expect(await names(agents.pay, 'suspended')).toEqual(['James Whitfield', 'Platform Admin', 'Ravi Menon'])
  })

  it('an agent route beats its department route; technical owner on request; inactive people are skipped', async () => {
    await addRoute({ name: 'Payments all', scope: 'department', department_id: payments, people: [u.daniel] })
    await addRoute({ name: 'Invoice Matcher team', scope: 'agent', agent_id: agents.pay, to_technical_owner: true, to_business_owner: true })
    expect(await names(agents.pay, 'access_without_authority')).toEqual(['James Whitfield', 'Tara Tech'])
    expect(await names(agents.pay2, 'access_without_authority')).toEqual(['Daniel Okafor'])
    await db.query(`update public.profiles set is_active = false where id = $1`, [u.tech])
    expect(await names(agents.pay, 'access_without_authority')).toEqual(['James Whitfield'])
    await db.query(`update public.profiles set is_active = true where id = $1`, [u.tech])
  })

  it('only admins change routes (audited); executives and auditors may read; the default cannot be deleted or switched off', async () => {
    await expect(asUser(db, u.james, (tx) => tx.query(`insert into public.alert_routes (name, scope, to_admins) values ('x', 'department', true)`)))
      .rejects.toThrow(/row-level security|violates/)
    expect(await asUser(db, u.james, async (tx) => (await tx.query(`select * from public.alert_routes`)).rows)).toEqual([])
    expect((await asUser(db, u.cro, async (tx) => (await tx.query(`select * from public.alert_routes`)).rows)).length).toBeGreaterThan(0)
    await expect(admin(`delete from public.alert_routes where scope = 'default'`)).rejects.toThrow(/cannot be deleted/)
    await expect(admin(`update public.alert_routes set is_active = false where scope = 'default'`)).rejects.toThrow(/cannot be switched off/)
    await expect(addRoute({ name: 'Nobody', scope: 'department', department_id: hr })).rejects.toThrow(/alert_route_sends/)
    await expect(addRoute({ name: 'Bad', scope: 'department', department_id: hr, events: ['lunch'], to_admins: true })).rejects.toThrow(/check/)
    const audit = (await db.query<{ action: string }>(`select action from public.audit_events where entity_type = 'alert_routes' order by seq`)).rows
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['alert_routes.insert', 'alert_routes.update']))
  })

  it('Test an alert: who would get it and why; not for owners', async () => {
    const out = await asUser(db, u.cro, async (tx) => (await tx.query<{ r: { name: string; route: string }[] }>(
      `select public.preview_alert_route($1, 'suspended') r`, [agents.hr])).rows[0].r)
    expect(out.map((x) => `${x.name} (${x.route})`)).toEqual(['James Whitfield (Default)', 'Platform Admin (Default)', 'Ravi Menon (Default)'])
    await expect(asUser(db, u.james, (tx) => tx.query(`select public.preview_alert_route($1, 'suspended')`, [agents.hr]))).rejects.toThrow(/Only admins/)
  })
})
