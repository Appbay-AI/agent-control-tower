import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 5.1: alert emails (R4.1, R4.2). Done when: each event sends the specified email.
// Seven events; each email goes to every admin and the agent's business owner, and carries the owner, everyone who can
// use the agent with their role and department, the data it touches and the personal-data red flag.
describe('alert emails (task 5.1)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let payments: string
  let conn: string
  const PLATFORM = 'Northbridge Agent Platform (simulated)'

  type Row = { user_id: string; event: string; is_test: boolean; result: string | null; details: Record<string, any> }
  const queued = async (agent: string, event?: string) => (await db.query<Row>(
    `select user_id, event, is_test, result, details from public.email_outbox where kind = 'alert' and agent_id = $1 ${event ? 'and event = $2' : ''} order by id`,
    event ? [agent, event] : [agent])).rows

  beforeAll(async () => {
    db = await createDb()
    payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    u.gone = await createUser(db, 'gone@bank.test', ['admin'], 'Former Admin')
    await db.query(`update public.profiles set is_active = false where id = $1`, [u.gone])
    await db.query(`update public.profiles set job_title = 'Head of Payments Product', department_id = $2 where id = $1`, [u.james, payments])
    await grantScope(db, u.ravi, payments)
    await db.query(`select public.push_configure('https://main.example.pages.dev')`)
    await db.query(`select public.email_configure('re_test_key', null, 'inbox@company.example')`)
    await db.query(`select public.platform_configure('appian_simulator', $1, 'https://appbay-demo.appiancloud.com', 'k')`, [PLATFORM])
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id
  })
  beforeEach(async () => { await db.query(`select public.alert_email_mode('send')`) })

  async function liveAgent(name: string, data = '{internal}') {
    const id = await proposeAgent(db, u.james, { name, department_id: payments, risk_tier: 'high' })
    await db.query(`update public.agents set data_classifications = $2::public.data_classification[], systems_accessed = '{SAP}' where id = $1`, [id, data])
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'approved' where id = $1`, [id])
    await db.query(`update public.agents set status = 'live' where id = $1`, [id])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    return id
  }
  const facts = (r: Row) => Object.fromEntries(r.details.facts as [string, string][])

  it('suspended: to every active admin and the business owner, with the reason and who did it; once only', async () => {
    const id = await liveAgent('Invoice Matcher')
    await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Matching invoices to the wrong orders')`, [id]))
    const rows = await queued(id, 'suspended')
    expect(rows.map((r) => r.user_id).sort()).toEqual([u.admin, u.james].sort()) // not the deactivated admin
    const d = rows[0].details
    expect(d.headline).toMatch(/^AGT-\d{4} Invoice Matcher was suspended$/)
    expect(facts(rows[0])).toMatchObject({ Why: 'Matching invoices to the wrong orders', 'Suspended by': 'James Whitfield' })
    expect(rows.find((r) => r.user_id === u.james)!.details.because).toBe('You are the business owner of Invoice Matcher.')
    expect(rows.find((r) => r.user_id === u.admin)!.details.because).toBe('You are an admin of Agent Control Tower.')
    // What every alert email carries (R4.2).
    expect(d.agent).toMatchObject({ name: 'Invoice Matcher', status: 'suspended', risk_tier: 'high', department: 'Payments' })
    expect(d.owner).toEqual({ name: 'James Whitfield', email: 'james@bank.test', role: 'Head of Payments Product' })
    expect(d.data).toEqual(['internal'])
    expect(d.systems).toEqual(['SAP'])
    expect(d.pii).toBe(false)
    expect(d.people).toEqual([{ name: 'James Whitfield', email: 'james@bank.test', role: 'Head of Payments Product', department: 'Payments',
      how: ['Business owner'], missing: [] }])
    expect(rows.every((r) => !r.is_test && r.result === null)).toBe(true)
  })

  it('switched back on: who asked, who approved and why', async () => {
    const id = await liveAgent('Statement Bot')
    await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Wrong balances')`, [id]))
    await db.query(`update public.incidents set status = 'contained', containment = 'Suspended' where agent_id = $1`, [id])
    const r = await asUser(db, u.james, async (tx) => (await tx.query<{ r: string }>(`select public.request_reactivation($1, 'Fix deployed and tested') r`, [id])).rows[0].r)
    await asUser(db, u.ravi, (tx) => tx.query(`select public.approve_reactivation($1, 'Checked')`, [r]))
    const [row] = await queued(id, 'reactivated')
    expect(row.details.headline).toMatch(/^AGT-\d{4} Statement Bot was switched back on$/)
    expect(facts(row)).toMatchObject({ 'Why it is safe': 'Fix deployed and tested', 'Asked by': 'James Whitfield', 'Approved by': 'Ravi Menon' })
  })

  it('a Critical incident suspends it: the email says Control Tower did it, automatically', async () => {
    const id = await liveAgent('Refund Bot')
    await asUser(db, u.james, (tx) => tx.query(`select public.report_incident($1, 'Refunds paid twice', 'critical', 'Seen in the ledger')`, [id]))
    const [row] = await queued(id, 'suspended')
    expect(facts(row)['Suspended by']).toMatch(/^Control Tower, automatically \(Critical incident INC-\d{4}\)$/)
  })

  it('re-quarantined: expected, seen, who, what was done and the incident', async () => {
    const id = await liveAgent('Payroll Checker')
    await db.query(`insert into public.drift_events (agent_id, kind, expected, observed, actor, action, result)
      values ($1, 'switched_on_outside', 'Blocked on Appian', 'Active on Appian as NAP-002', 'maria.lopez on Appian (outside Control Tower)',
              'Blocked again; Critical incident INC-0009; admins alerted', 'Blocking again…')`, [id])
    const [row] = await queued(id, 're_quarantined')
    expect(row.details.headline).toMatch(/switched back on outside Control Tower and is being blocked again$/)
    expect(facts(row)).toMatchObject({ Expected: 'Blocked on Appian', Seen: 'Active on Appian as NAP-002', Who: 'maria.lopez on Appian (outside Control Tower)' })
  })

  it('enforcement pending: what has not worked and what happens next', async () => {
    const id = await liveAgent('Cash Mover')
    await db.query(`insert into public.alerts (kind, agent_id, message) values ('enforcement_pending', $1,
      'AGT-0099 is suspended, but stopping it on Appian has not worked yet: Appian did not answer. Trying again at 10:15 UTC.')`, [id])
    const [row] = await queued(id, 'enforcement_pending')
    expect(facts(row)['What has not worked']).toMatch(/Appian did not answer/)
    expect(facts(row)['What happens now']).toMatch(/keeps trying/)
  })

  it('discovered, then missing at source: found as, owner on the platform, what to do', async () => {
    await db.query(`delete from public.email_outbox`)
    await db.query(`insert into public.platform_agents (connection_id, external_id, name, status, details)
      values ($1, 'NAP-005', 'Credit Memo Helper', 'active', '{"owner": {"email": "nobody@elsewhere.test", "name": "Aisha Rahman"}, "dataClassifications": ["confidential"]}')`, [conn])
    await db.query(`select public.platform_agents_govern($1)`, [conn])
    const agent = (await db.query<{ id: string }>(`select agent_id id from public.platform_agents where external_id = 'NAP-005'`)).rows[0].id
    const [found] = await queued(agent, 'discovered')
    expect(found.details.headline).toBe(`New agent found on ${PLATFORM}: Credit Memo Helper, not registered`)
    expect(facts(found)).toMatchObject({ 'Found as': `NAP-005 on ${PLATFORM}`, 'Owner on the platform': 'Aisha Rahman' })
    expect((await queued(agent, 'discovered')).map((r) => r.user_id)).toEqual([u.admin]) // no business owner in Control Tower
    expect(found.details.platform).toMatchObject({ name: PLATFORM, external_id: 'NAP-005' })

    await db.query(`update public.platform_agents set missing_since = now() where external_id = 'NAP-005'`)
    const [missing] = await queued(agent, 'missing_at_source')
    expect(missing.details.headline).toMatch(new RegExp(`is no longer listed on ${PLATFORM.replace(/[()]/g, '\\$&')}$`))
    expect(facts(missing)).toMatchObject({ Was: `NAP-005 on ${PLATFORM}`, 'In Control Tower': 'Proposed' })
  })

  it('access without authority: the person, role, how, what they lack; personal data is red-flagged with departments', async () => {
    const id = await liveAgent('Sales Lead Summariser', '{personal}')
    await db.query(`insert into public.platform_agents (connection_id, external_id, name, status, details, agent_id)
      values ($1, 'NAP-003', 'Sales Lead Summariser', 'active', $2::jsonb, $3)`, [conn, JSON.stringify({
        owner: { email: 'james@bank.test', name: 'James Whitfield' }, dataClassifications: ['personal'],
        sharedWith: [{ email: 'ana@bank.test', name: 'Ana Costa', jobTitle: 'Sales Associate', department: 'Retail Lending' }] }), id])
    const [row] = await queued(id, 'access_without_authority')
    expect(row.details.headline).toMatch(/^Ana Costa can use AGT-\d{4} Sales Lead Summariser without authority for Personal data$/)
    expect(facts(row)).toMatchObject({ Person: 'Ana Costa (ana@bank.test)', Role: 'Sales Associate', 'Not authorised for': 'Personal' })
    expect(row.details.pii).toBe(true)
    expect(row.details.people).toContainEqual({ name: 'Ana Costa', email: 'ana@bank.test', role: 'Sales Associate', department: 'Retail Lending',
      how: [`Shared on ${PLATFORM}`], missing: ['personal'] })
  })

  it('the sender gets alert emails with their snapshot; approval emails are unchanged', async () => {
    await db.query(`delete from public.email_outbox`)
    await db.query(`delete from net.calls`)
    const id = await liveAgent('Claims Bot')
    await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Odd results')`, [id]))
    const t = (await db.query<{ t: string }>(`select body ->> 'token' t from net.calls where url like '%/push/dispatch' order by id desc limit 1`)).rows[0].t
    const c = await asRole(db, 'anon', async (tx) => (await tx.query<{ r: { emails: { kind: string; alert: Record<string, any>; to_name: string }[] } }>(`select public.push_claim($1) r`, [t])).rows[0].r)
    const mine = c.emails.filter((e) => e.kind === 'alert' && e.alert.agent.id === id)
    expect(mine.map((e) => e.to_name).sort()).toEqual(['James Whitfield', 'Platform Admin'])
    expect(mine[0].alert).toMatchObject({ event: 'suspended', headline: expect.stringMatching(/Claims Bot was suspended$/) })
  })

  it('work-in-progress site: alert emails go to the test inbox, 20 a day at most', async () => {
    await db.query(`select public.alert_email_mode('test_inbox')`)
    await db.query(`delete from public.email_outbox`)
    const id = await liveAgent('Noisy Bot')
    for (let i = 0; i < 12; i++) {
      await db.query(`insert into public.alerts (kind, agent_id, message) values ('enforcement_pending', $1, 'Not yet')`, [id])
      await db.query(`delete from public.alerts where agent_id = $1 and kind = 'enforcement_pending'`, [id])
    }
    const rows = await queued(id, 'enforcement_pending') // 12 events × 2 people
    expect(rows.every((r) => r.is_test)).toBe(true)
    expect(rows.filter((r) => r.result === null)).toHaveLength(20)
    expect(rows.filter((r) => r.result === 'Not sent: test site daily limit for alert emails (20) reached')).toHaveLength(4)
  })

  it('who was told, on the agent page: only for people who can see the agent', async () => {
    const id = await liveAgent('Told Bot')
    await asUser(db, u.james, (tx) => tx.query(`select public.suspend_agent($1, 'Checking')`, [id]))
    const told = await asUser(db, u.james, async (tx) => (await tx.query<{ event: string; person: string }>(
      `select event, person from public.agent_alert_emails($1)`, [id])).rows)
    expect(told.map((x) => `${x.event} ${x.person}`).sort()).toEqual(['suspended James Whitfield', 'suspended Platform Admin'])
    const outsider = await createUser(db, 'out@bank.test', ['owner'])
    expect(await asUser(db, outsider, async (tx) => (await tx.query(`select * from public.agent_alert_emails($1)`, [id])).rows)).toEqual([])
  })
})
