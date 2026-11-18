import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, proposeAgent } from './harness'

// Task 6.7 (R5.4): the personal-data access mismatch report. Done when: mismatches are listed with roles. Mismatches
// come from the real data-authority check (task 4.8): agents shared on the platform with people whose role is not
// authorised for the agent's data.
describe('access mismatch report (task 6.7)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  const ag: Record<string, string> = {}
  let conn: string
  type R = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const report = (who: string, personalOnly = true) =>
    asUser(db, who, async (tx) => (await tx.query<{ r: R }>(`select public.pii_mismatch_report($1) r`, [personalOnly])).rows[0].r)
  const person = (email: string, name: string, jobTitle: string) => ({ email, name, jobTitle })
  // The platform record keeps the agent's name (a linked agent takes the platform's name).
  const onPlatform = (id: string, agent: string, data: string[], shared: object[]) =>
    db.query(`insert into public.platform_agents (connection_id, external_id, name, status, details, agent_id)
              values ($1, $2, (select name from public.agents where id = $4), 'active', $3::jsonb, $4)`,
      [conn, id, JSON.stringify({ owner: { email: 'tom@bank.test', name: 'Tom Becker' }, dataClassifications: data, sharedWith: shared }), agent])

  beforeAll(async () => {
    db = await createDb()
    const lending = await createDepartment(db, 'Retail Lending')
    u.auditor = await createUser(db, 'auditor@bank.test', ['auditor'], 'Mei Lin')
    u.tom = await createUser(db, 'tom@bank.test', ['owner'], 'Tom Becker')
    u.sam = await createUser(db, 'sam@bank.test', ['owner', 'approver'], 'Sam Intern')
    await db.query(`update public.profiles set job_title = 'Automation Engineering Lead' where id = $1`, [u.tom])
    await db.query(`update public.profiles set job_title = 'Graduate Intern' where id = $1`, [u.sam])
    await db.query(`select public.platform_configure('appian_simulator', 'Northbridge Agent Platform (simulated)', 'https://appbay-demo.appiancloud.com', 'k')`)
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id

    // A: personal and confidential data, shared with Ana (Sales Associate, not a Control Tower user) and Sam (Graduate
    // Intern, a user). B: confidential only, shared with Ana. C: personal, shared with Ana, then retired (left out).
    for (const [k, data] of [['a', '{personal,confidential}'], ['b', '{confidential}'], ['c', '{personal}']] as const) {
      ag[k] = await proposeAgent(db, u.tom, { name: `Agent ${k}`, department_id: lending })
      await db.query(`update public.agents set data_classifications = $2 where id = $1`, [ag[k], data])
    }
    await onPlatform('NAP-A', ag.a, ['personal', 'confidential'], [person('ana@bank.test', 'Ana Costa', 'Sales Associate'), person('sam@bank.test', 'Sam Intern', '')])
    await onPlatform('NAP-B', ag.b, ['confidential'], [person('ana@bank.test', 'Ana Costa', 'Sales Associate')])
    await onPlatform('NAP-C', ag.c, ['personal'], [person('ana@bank.test', 'Ana Costa', 'Sales Associate')])
    await db.query(`select set_config('act.allow_lifecycle', 'on', false)`)
    await db.query(`update public.agents set status = 'retired' where id = $1`, [ag.c])
    await db.query(`select set_config('act.allow_lifecycle', '', false)`)
  })

  const allowed = async (kinds: string[]) => (await db.query<{ t: string }>(
    `select job_title t from public.data_authority where classification = any(string_to_array($1, ',')::public.data_classification[])
      group by job_title having count(distinct classification) = $2 order by job_title`, [kinds.join(','), kinds.length])).rows.map((r) => r.t)

  it('personal data: each mismatch with the person, their role, Control Tower roles, how, what is missing and who may', async () => {
    const r = await report(u.auditor)
    expect(r).toMatchObject({ personal_only: true, total: 2, people: 2, agents: 1 })
    const rows = Object.fromEntries(r.rows.map((x: R) => [x.name, x]))
    expect(rows['Ana Costa']).toMatchObject({ agent: expect.stringContaining('Agent a'), role: 'Sales Associate', ct_roles: [], ct_user: false,
      how: ['Shared on Northbridge Agent Platform (simulated)'], data: ['confidential', 'personal'] })
    expect(rows['Sam Intern']).toMatchObject({ role: 'Graduate Intern', ct_roles: ['approver', 'owner'], ct_user: true, active: true })
    for (const x of r.rows) {
      expect(x.missing).toContain('personal')
      expect(x.authorised_roles).toEqual(await allowed(x.missing))
    }
    expect(r.by_role.map((x: R) => x.role).sort()).toEqual(['Graduate Intern', 'Sales Associate'])
    expect(r.matrix.personal).toEqual(await allowed(['personal']))
  })

  it('every kind: also the confidential-only mismatch; the retired agent never', async () => {
    const r = await report(u.auditor, false)
    const names = r.rows.map((x: R) => `${x.agent.split(' ').slice(1).join(' ')} ${x.name}`).sort()
    const conf = await allowed(['confidential'])
    // Ana is in the report for B only if her role may not see confidential data.
    expect(names).toEqual(['Agent a Ana Costa', 'Agent a Sam Intern', ...(conf.includes('Sales Associate') ? [] : ['Agent b Ana Costa'])].sort())
    expect(JSON.stringify(r)).not.toContain('Agent c')
    expect(r.by_kind.personal).toBe(2)
  })

  it('admins, executives and auditors only', async () => {
    await expect(report(u.tom)).rejects.toThrow(/Only admins, executives and auditors/)
  })
})
