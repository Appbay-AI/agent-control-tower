import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 3.5: agents found on a platform enter the registry as Discovered and must pass registration approval (R1.4).
describe('discovered agents (task 3.5)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  const d: Record<string, string> = {}
  let conn: string
  let invoiceMatcher: string
  const PLATFORM = 'Northbridge Agent Platform (simulated)'

  beforeAll(async () => {
    db = await createDb()
    d.cs = await createDepartment(db, 'Customer Service')
    d.payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.lucy = await createUser(db, 'lucy.grant@northbridge.demo', ['owner'], 'Lucy Grant')
    u.james = await createUser(db, 'james.whitfield@northbridge.demo', ['owner'], 'James Whitfield')
    u.sara = await createUser(db, 'sara@bank.test', ['approver'], 'Sara Haddad')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    await grantScope(db, u.sara, d.cs)
    await grantScope(db, u.ravi, d.payments)
    // Registered by hand before the platform was connected (as Appbay does with NAP-002).
    invoiceMatcher = await proposeAgent(db, u.james, { name: 'Invoice Matcher', department_id: d.payments })
    await db.query(`select public.push_configure('https://main.agent-control-tower-56p.pages.dev')`)
    await db.query(`select public.platform_configure('appian_simulator', $1, 'https://appbay-demo.appiancloud.com', 'key-1')`, [PLATFORM])
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id
  })

  const nap = (id: string, name: string, owner: [string, string] | null, department: string, extra: Record<string, unknown> = {}) => ({
    externalId: id, name, status: 'active', description: `${name} (from Appian)`, environment: 'Production', department,
    owner: owner && { email: owner[0], name: owner[1] }, dataSources: ['Core banking', 'CRM'], tools: ['Payments API'],
    dataClassifications: ['personal', 'confidential', 'secret'], sharedWith: [], ...extra,
  })
  const LIST = [
    nap('NAP-001', 'Refund Processor', ['Lucy.Grant@northbridge.demo', 'Lucy Grant'], 'Customer Service'),
    nap('NAP-002', 'Invoice Matcher', ['james.whitfield@northbridge.demo', 'James Whitfield'], 'Payments'),
    nap('NAP-004', 'Branch Rota Planner', null, 'Operations'),
  ]

  async function sync(agents: unknown[]) {
    await asUser(db, u.admin, (tx) => tx.query(`select public.platform_job_start($1, 'sync')`, [conn]))
    const token = (await db.query<{ t: string }>(`select body ->> 'token' t from net.calls order by id desc limit 1`)).rows[0].t
    await asRole(db, 'anon', (tx) => tx.query(`select public.platform_job_claim($1)`, [token]))
    const out = await asRole(db, 'anon', async (tx) => (await tx.query<{ r: Record<string, number> }>(
      `select public.platform_sync_apply($1, $2::jsonb) r`, [token, JSON.stringify(agents)])).rows[0].r)
    await asRole(db, 'anon', (tx) => tx.query(`select public.platform_job_report($1, true, 'Synced', $2::jsonb)`, [token, JSON.stringify(out)]))
    return out
  }
  type AgentRow = { id: string; agent_code: string; name: string; status: string; registration_source: string; business_owner_id: string | null;
    department_id: string | null; purpose_statement: string; framework: string; systems_accessed: string[]; data_classifications: string; description: string }
  const registryAgent = async (externalId: string) => (await db.query<AgentRow>(
    `select a.id, a.agent_code, a.name, a.status, a.registration_source, a.business_owner_id, a.department_id, a.purpose_statement, a.framework,
            a.systems_accessed, a.data_classifications::text, a.description
       from public.platform_agents pa join public.agents a on a.id = pa.agent_id where pa.external_id = $1`, [externalId])).rows[0]
  const openAlerts = async (agentId: string) => (await db.query<{ kind: string; message: string }>(
    `select kind, message from public.alerts where agent_id = $1 and resolved_at is null and kind <> 'data_authority'` /* 4.8 has its own tests */, [agentId])).rows
  const pushes = async () => (await db.query<{ user_id: string; title: string; body: string; url: string }>(
    `select user_id, title, body, url from public.push_outbox where kind = 'alert' and title like '%Found, not registered%' order by user_id, title`)).rows

  it('a sync puts each ungoverned agent in the registry as Discovered, and links one already registered', async () => {
    expect(await sync(LIST)).toMatchObject({ agents: 3, new: 3, registered: 2, linked: 1 })
    // Already registered by hand, same name and owner: linked, not duplicated.
    expect((await registryAgent('NAP-002')).id).toBe(invoiceMatcher)
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.agents where lower(name) = 'invoice matcher'`)).rows[0].n).toBe(1)

    const refund = await registryAgent('NAP-001')
    expect(refund).toMatchObject({ name: 'Refund Processor', status: 'proposed', registration_source: 'discovered', business_owner_id: u.lucy,
      department_id: d.cs, purpose_statement: '', framework: 'appian', description: 'Refund Processor (from Appian)',
      systems_accessed: ['CRM', 'Core banking', 'Payments API'], data_classifications: '{confidential,personal}' })
    // No owner in Control Tower and no such department: left blank for a person to fill in.
    expect(await registryAgent('NAP-004')).toMatchObject({ status: 'proposed', business_owner_id: null, department_id: null })
  })

  it('raises a "not registered" alert on each, and alerts the admins and the owner once per sync', async () => {
    const refund = await registryAgent('NAP-001')
    const rota = await registryAgent('NAP-004')
    expect(await openAlerts(refund.id)).toEqual([{ kind: 'agent_discovered',
      message: `${refund.agent_code} was found on ${PLATFORM} as NAP-001 and is not registered. Name a business owner, write its purpose and submit it for approval, or retire it.` }])
    expect((await openAlerts(rota.id))[0].message).toContain('and is not registered (no owner in Control Tower).')
    expect(await openAlerts(invoiceMatcher)).toEqual([])

    const sent = await pushes()
    // Task 5.4: one phone alert per agent, following the alert routes (default: every admin and the business owner).
    expect(sent.filter((p) => p.user_id === u.admin).map((p) => p.url).sort()).toEqual([`/agents/${refund.id}`, `/agents/${rota.id}`].sort())
    expect(sent.find((p) => p.user_id === u.lucy)).toEqual({ user_id: u.lucy, title: `Personal data · Found, not registered · ${refund.agent_code}`,
      body: `New agent found on ${PLATFORM}: Refund Processor, not registered`, url: `/agents/${refund.id}` })
    expect(sent.map((p) => p.user_id)).not.toContain(u.james)
  })

  it('records who added them: the integration, with the platform and its id as the reason', async () => {
    const refund = await registryAgent('NAP-001')
    expect((await db.query<{ actor_type: string; reason: string }>(
      `select actor_type, reason from public.audit_events where entity_type = 'agents' and action = 'agents.insert' and entity_id = $1`, [refund.id])).rows)
      .toEqual([{ actor_type: 'integration', reason: `Found on ${PLATFORM} as NAP-001` }])
    expect((await db.query<{ summary: string }>(`select summary from public.audit_events where action = 'platform_agents.linked'`)).rows[0].summary)
      .toMatch(/^NAP-002 Invoice Matcher on .* is AGT-\d{4} in the registry$/)
    expect((await db.query<{ broken: number }>(`select count(*)::int broken from public.audit_verify_chain()`)).rows[0].broken).toBe(0)
  })

  it('the next sync adds nothing twice and alerts nobody again', async () => {
    const before = (await pushes()).length
    expect(await sync(LIST)).toMatchObject({ new: 0, registered: 0, linked: 0 })
    expect((await pushes()).length).toBe(before)
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.agents where registration_source = 'discovered'`)).rows[0].n).toBe(2)
  })

  it('a discovered agent cannot reach Live unapproved: it needs an owner, a purpose, a department and an approver', async () => {
    const refund = await registryAgent('NAP-001')
    const rota = await registryAgent('NAP-004')
    await expect(asUser(db, u.lucy, (tx) => tx.query(`select public.go_live($1)`, [refund.id]))).rejects.toThrow(/Only Approved agents can go live/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`update public.agents set status = 'live' where id = $1`, [refund.id])))
      .rejects.toThrow(/permission denied|change only through the approval workflow/)
    await expect(asUser(db, u.lucy, (tx) => tx.query(`select public.submit_agent_for_approval($1)`, [refund.id]))).rejects.toThrow(/purpose statement/)
    await expect(asUser(db, u.admin, (tx) => tx.query(`select public.submit_agent_for_approval($1)`, [rota.id]))).rejects.toThrow(/business owner/)

    // Lucy, its owner, writes the purpose and submits; Sara (Customer Service approver) approves.
    await asUser(db, u.lucy, (tx) => tx.query(`update public.agents set purpose_statement = 'Issue customer refunds under £500' where id = $1`, [refund.id]))
    const reg = await asUser(db, u.lucy, async (tx) => (await tx.query<{ id: string }>(`select public.submit_agent_for_approval($1) id`, [refund.id])).rows[0].id)
    await expect(asUser(db, u.ravi, (tx) => tx.query(`select public.decide_registration($1, 'approve')`, [reg]))).rejects.toThrow(/not an approver for this agent/)
    await asUser(db, u.sara, (tx) => tx.query(`select public.decide_registration($1, 'approve')`, [reg]))
    expect((await registryAgent('NAP-001')).status).toBe('approved')
    expect(await openAlerts(refund.id)).toEqual([]) // approved: no longer "not registered"
    await asUser(db, u.lucy, (tx) => tx.query(`select public.go_live($1)`, [refund.id]))
    expect((await registryAgent('NAP-001')).status).toBe('live')
  })

  it('retiring a discovered agent clears its alert, and the next sync does not bring it back', async () => {
    const rota = await registryAgent('NAP-004')
    await asUser(db, u.admin, (tx) => tx.query(`select public.retire_agent($1, 'Not used by the bank: switched off in Appian next week')`, [rota.id]))
    expect(await openAlerts(rota.id)).toEqual([])
    expect(await sync(LIST)).toMatchObject({ registered: 0 })
    expect((await registryAgent('NAP-004')).id).toBe(rota.id)
  })

  it('owners see the platform record of their agent; approvers outside its department do not', async () => {
    const seen = (who: string) => asUser(db, who, async (tx) => (await tx.query<{ external_id: string }>(
      `select external_id from public.platform_agents order by external_id`)).rows.map((r) => r.external_id))
    expect(await seen(u.lucy)).toEqual(['NAP-001'])
    expect(await seen(u.james)).toEqual(['NAP-002'])
    expect(await seen(u.ravi)).toEqual(['NAP-002']) // Payments approver: sees Invoice Matcher
    expect(await seen(u.admin)).toEqual(['NAP-001', 'NAP-002', 'NAP-004'])
  })

  it("the agent's page can show where it was found, to whoever can see the agent", async () => {
    const refund = await registryAgent('NAP-001')
    const record = (who: string) => asUser(db, who, async (tx) => (await tx.query<{ r: Record<string, unknown> | null }>(
      `select public.platform_record_for_agent($1) r`, [refund.id])).rows[0].r)
    expect(await record(u.lucy)).toMatchObject({ platform: PLATFORM, external_id: 'NAP-001', status: 'active', owner_email: 'Lucy.Grant@northbridge.demo', missing_since: null })
    expect(await record(u.sara)).toMatchObject({ external_id: 'NAP-001' })
    expect(await record(u.ravi)).toBeNull() // Payments approver: cannot see a Customer Service agent
  })
})
