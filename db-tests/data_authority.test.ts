import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, proposeAgent } from './harness'

// Task 4.8: the data-authority matrix (which roles may see which data) and the check of everyone who can use an agent.
// Done when: a new person without authority raises an alert.
describe('data-authority matrix (task 4.8)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  let lending: string
  let conn: string
  let agent: string
  let pa: string
  const PLATFORM = 'Northbridge Agent Platform (simulated)'
  const person = (email: string, name: string, jobTitle: string) => ({ email, name, jobTitle, department: 'Retail Lending' })

  beforeAll(async () => {
    db = await createDb()
    lending = await createDepartment(db, 'Retail Lending')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.tom = await createUser(db, 'tom@bank.test', ['owner'], 'Tom Becker')
    u.sam = await createUser(db, 'sam@bank.test', ['owner'], 'Sam Intern')
    u.other = await createUser(db, 'other@bank.test', ['owner'], 'Someone Else')
    await db.query(`update public.profiles set job_title = 'Automation Engineering Lead' where id = $1`, [u.tom])
    await db.query(`update public.profiles set job_title = 'Graduate Intern' where id = $1`, [u.sam])
    await db.query(`select public.platform_configure('appian_simulator', $1, 'https://appbay-demo.appiancloud.com', 'k')`, [PLATFORM])
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id
    agent = await proposeAgent(db, u.tom, { name: 'Sales Lead Summariser', department_id: lending })
    await db.query(`update public.agents set data_classifications = '{personal}' where id = $1`, [agent])
  })

  const findings = async () => (await db.query<{ email: string; job_title: string | null; how: string[]; missing: string }>(
    `select email, job_title, how, missing::text from public.agent_authority_findings where agent_id = $1 order by email`, [agent])).rows
  const alert = async () => (await db.query<{ message: string }>(
    `select message from public.alerts where agent_id = $1 and kind = 'data_authority' and resolved_at is null`, [agent])).rows[0]?.message ?? null
  const pushes = async () => (await db.query<{ user_id: string; title: string; body: string }>(
    `select user_id, title, body from public.push_outbox where kind = 'data_authority' order by id`)).rows
  const share = async (people: object[]) => db.query(
    `update public.platform_agents set details = jsonb_set(details, '{sharedWith}', $1::jsonb) where id = $2`, [JSON.stringify(people), pa])

  it('the starting matrix: public and internal for everyone, personal for the roles that need it, not for Sales Associate', async () => {
    const rows = (await db.query<{ job_title: string; classification: string }>(
      `select job_title, classification::text from public.data_authority where job_title in ('*', 'Customer Service Agent', 'Sales Associate') order by 1, 2`)).rows
    expect(rows).toEqual([
      { job_title: '*', classification: 'internal' }, { job_title: '*', classification: 'public' },
      { job_title: 'Customer Service Agent', classification: 'confidential' }, { job_title: 'Customer Service Agent', classification: 'personal' },
    ])
    expect(await findings()).toEqual([]) // its owner (Automation Engineering Lead) may see personal data
  })

  it('found on the platform shared with a Sales Associate: a finding, an alert, the admin and owner told, on the record', async () => {
    await db.query(`delete from public.push_outbox`)
    pa = (await db.query<{ id: string }>(`insert into public.platform_agents (connection_id, external_id, name, status, details, agent_id)
      values ($1, 'NAP-003', 'Sales Lead Summariser', 'active', $2::jsonb, $3) returning id`,
      [conn, JSON.stringify({ owner: { email: 'tom@bank.test', name: 'Tom Becker' }, dataClassifications: ['personal'], sharedWith: [person('ana@bank.test', 'Ana Costa', 'Sales Associate')] }), agent])).rows[0].id
    expect(await findings()).toEqual([{ email: 'ana@bank.test', job_title: 'Sales Associate', how: [`Shared on ${PLATFORM}`], missing: '{personal}' }])
    expect(await alert()).toMatch(/^AGT-\d{4} can be used by someone without authority for its data: Ana Costa \(Sales Associate\) for Personal\.$/)
    const p = await pushes()
    expect(p.map((x) => x.user_id).sort()).toEqual([u.admin, u.tom].sort())
    expect(p[0].title).toMatch(/^No authority · AGT-\d{4}$/)
    expect(p[0].body).toBe('Ana Costa (Sales Associate) can use Sales Lead Summariser without authority for its data. Check the Data authority matrix or remove their access.')
    const audit = (await db.query<{ summary: string; actor_type: string }>(`select summary, actor_type from public.audit_events where action = 'agents.access_without_authority' and agent_id = $1`, [agent])).rows
    expect(audit).toEqual([{ actor_type: 'system', summary: expect.stringMatching(/^Ana Costa \(Sales Associate, Shared on .*\) can use AGT-\d{4}, which handles Personal data; that role is not authorised for it$/) }])
  })

  it('sharing changes on the platform are recorded as outside Control Tower; only a NEW person without authority is news', async () => {
    await db.query(`delete from public.push_outbox`)
    await share([person('ana@bank.test', 'Ana Costa', 'Sales Associate'), person('ben@bank.test', 'Ben Ode', 'Customer Service Agent')])
    const change = (await db.query<{ summary: string }>(`select summary from public.audit_events where action = 'platform_agents.sharing_changed' order by seq desc limit 1`)).rows[0].summary
    expect(change).toMatch(/^AGT-\d{4} on .* as NAP-003; shared with Ben Ode \(Customer Service Agent\)\. Changed outside Control Tower \(actor unknown\)\.$/)
    expect(await pushes()).toEqual([]) // Ben may see personal data; Ana was already known
    await share([person('ana@bank.test', 'Ana Costa', 'Sales Associate'), person('ben@bank.test', 'Ben Ode', 'Customer Service Agent'),
      person('cara@bank.test', 'Cara Lee', 'Sales Associate')])
    expect((await findings()).map((f) => f.email)).toEqual(['ana@bank.test', 'cara@bank.test'])
    expect(await alert()).toMatch(/by 2 people .*: Ana Costa \(Sales Associate\) for Personal; Cara Lee \(Sales Associate\) for Personal\.$/)
    expect((await pushes()).map((x) => x.body)).toEqual([expect.stringMatching(/^Cara Lee \(Sales Associate\) can use/), expect.stringMatching(/^Cara Lee/)])
  })

  it('a new owner in Control Tower without authority raises the alert too', async () => {
    await db.query(`delete from public.push_outbox`)
    await db.query(`update public.agents set technical_owner_id = $1 where id = $2`, [u.sam, agent])
    expect((await findings()).find((f) => f.email === 'sam@bank.test')).toEqual({ email: 'sam@bank.test', job_title: 'Graduate Intern', how: ['Technical owner'], missing: '{personal}' })
    expect((await pushes()).length).toBeGreaterThan(0)
    // A promotion fixes it: the job title change is checked again.
    await db.query(`update public.profiles set job_title = 'Customer Service Agent' where id = $1`, [u.sam])
    expect((await findings()).map((f) => f.email)).not.toContain('sam@bank.test')
  })

  it('admins change the matrix; every agent is checked again at once; others cannot change it', async () => {
    await expect(asUser(db, u.tom, (tx) => tx.query(`select public.set_data_authority('Sales Associate', 'personal', true)`))).rejects.toThrow(/Only admins/)
    await asUser(db, u.admin, (tx) => tx.query(`select public.set_data_authority('Sales Associate', 'personal', true)`))
    expect(await findings()).toEqual([])
    expect(await alert()).toBeNull()
    const reason = (await db.query<{ reason: string }>(`select reason from public.audit_events where entity_type = 'data_authority' order by seq desc limit 1`)).rows[0].reason
    expect(reason).toBe('Allowed Personal data: Sales Associate')
    await asUser(db, u.admin, (tx) => tx.query(`select public.set_data_authority('Sales Associate', 'personal', false)`))
    expect((await findings()).map((f) => f.email)).toEqual(['ana@bank.test', 'cara@bank.test'])
  })

  it('removing the access clears the finding and the alert; a retired agent is not checked', async () => {
    await share([person('ben@bank.test', 'Ben Ode', 'Customer Service Agent')])
    expect(await findings()).toEqual([])
    expect(await alert()).toBeNull()
    expect((await db.query<{ summary: string }>(`select summary from public.audit_events where action = 'platform_agents.sharing_changed' order by seq desc limit 1`)).rows[0].summary)
      .toMatch(/no longer shared with Ana Costa, Cara Lee\./)
    await share([person('ana@bank.test', 'Ana Costa', 'Sales Associate')])
    expect(await findings()).toHaveLength(1)
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'retired' where id = $1`, [agent])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
    expect(await findings()).toEqual([])
    expect(await alert()).toBeNull()
  })

  it('who can use it, for the agent page: everyone with their role and what they lack; nothing for people who cannot see the agent', async () => {
    const other = await proposeAgent(db, u.tom, { name: 'Other', department_id: lending })
    await db.query(`update public.agents set data_classifications = '{personal,internal}' where id = $1`, [other])
    const rows = await asUser(db, u.tom, async (tx) => (await tx.query<{ email: string; how: string[]; missing: string }>(
      `select email, how, missing::text from public.agent_access($1)`, [other])).rows)
    expect(rows).toEqual([{ email: 'tom@bank.test', how: ['Business owner'], missing: '{}' }])
    expect(await asUser(db, u.other, async (tx) => (await tx.query(`select * from public.agent_access($1)`, [other])).rows)).toEqual([])
    const titles = await asUser(db, u.admin, async (tx) => (await tx.query<{ job_title: string }>(`select job_title from public.known_job_titles()`)).rows.map((r) => r.job_title))
    expect(titles).toEqual(expect.arrayContaining(['Sales Associate', 'Customer Service Agent', 'Automation Engineering Lead']))
  })
})
