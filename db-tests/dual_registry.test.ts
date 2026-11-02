import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asRole, asUser, createDb, createDepartment, createUser, grantScope, proposeAgent } from './harness'

// Task 3.6: the dual registry. Platform fields follow the platform and cannot be edited here; governance fields can.
describe('dual registry (task 3.6)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  const d: Record<string, string> = {}
  let conn: string
  let invoiceMatcher: string
  let handMade: string
  const PLATFORM = 'Northbridge Agent Platform (simulated)'

  beforeAll(async () => {
    db = await createDb()
    d.cs = await createDepartment(db, 'Customer Service')
    d.payments = await createDepartment(db, 'Payments')
    u.admin = await createUser(db, 'admin@bank.test', ['admin'], 'Platform Admin')
    u.lucy = await createUser(db, 'lucy.grant@northbridge.demo', ['owner'], 'Lucy Grant')
    u.james = await createUser(db, 'james.whitfield@northbridge.demo', ['owner'], 'James Whitfield')
    u.omar = await createUser(db, 'omar@bank.test', ['approver'], 'Omar Farouk')
    u.ravi = await createUser(db, 'ravi@bank.test', ['approver'], 'Ravi Menon')
    await grantScope(db, u.omar, d.cs)
    await grantScope(db, u.ravi, d.payments)
    invoiceMatcher = await proposeAgent(db, u.james, { name: 'Invoice Matcher', department_id: d.payments, description: 'Typed by hand',
      systems_accessed: '{ERP}', data_classifications: '{internal}' })
    handMade = await proposeAgent(db, u.lucy, { name: 'Hand-made helper', department_id: d.cs })
    await db.query(`select public.push_configure('https://main.agent-control-tower-56p.pages.dev')`)
    await db.query(`select public.platform_configure('appian_simulator', $1, 'https://appbay-demo.appiancloud.com', 'key-1')`, [PLATFORM])
    conn = (await db.query<{ id: string }>(`select id from public.platform_connections`)).rows[0].id
  })

  const nap = (id: string, name: string, owner: string, department: string, extra: Record<string, unknown> = {}) => ({
    externalId: id, name, status: 'active', description: `${name} (from Appian)`, department, owner: { email: owner, name: owner },
    dataSources: ['Core banking'], tools: ['Payments API'], dataClassifications: ['confidential'], sharedWith: [], ...extra,
  })
  async function sync(agents: unknown[]) {
    await asUser(db, u.admin, (tx) => tx.query(`select public.platform_job_start($1, 'sync')`, [conn]))
    const token = (await db.query<{ t: string }>(`select body ->> 'token' t from net.calls order by id desc limit 1`)).rows[0].t
    await asRole(db, 'anon', (tx) => tx.query(`select public.platform_job_claim($1)`, [token]))
    const out = await asRole(db, 'anon', async (tx) => (await tx.query<{ r: Record<string, number> }>(
      `select public.platform_sync_apply($1, $2::jsonb) r`, [token, JSON.stringify(agents)])).rows[0].r)
    await asRole(db, 'anon', (tx) => tx.query(`select public.platform_job_report($1, true, 'Synced')`, [token]))
    return out
  }
  const agentFor = async (externalId: string) => (await db.query<{ id: string; name: string; description: string; systems_accessed: string[]; data: string; status: string }>(
    `select a.id, a.name, a.description, a.systems_accessed, a.data_classifications::text data, a.status
       from public.platform_agents pa join public.agents a on a.id = pa.agent_id where pa.external_id = $1`, [externalId])).rows[0]
  const edit = (who: string, id: string, set: string, args: unknown[] = []) =>
    asUser(db, who, (tx) => tx.query(`update public.agents set ${set} where id = $1`, [id, ...args]))

  const LIST = [
    nap('NAP-001', 'Refund Processor', 'lucy.grant@northbridge.demo', 'Customer Service'),
    nap('NAP-002', 'Invoice Matcher', 'james.whitfield@northbridge.demo', 'Payments'),
  ]

  it('linking an agent registered by hand makes the platform the source of its platform fields', async () => {
    expect(await sync(LIST)).toMatchObject({ registered: 1, linked: 1 })
    expect(await agentFor('NAP-002')).toMatchObject({ id: invoiceMatcher, description: 'Invoice Matcher (from Appian)',
      systems_accessed: ['Core banking', 'Payments API'], data: '{confidential}' })
    const audit = (await db.query<{ actor_type: string; reason: string }>(
      `select actor_type, reason from public.audit_events where entity_id = $1 and action = 'agents.update' order by seq desc limit 1`, [invoiceMatcher])).rows[0]
    expect(audit).toEqual({ actor_type: 'integration', reason: `Updated from ${PLATFORM} (NAP-002)` })
  })

  it('platform fields cannot be edited in Control Tower, by the owner or an admin', async () => {
    const refund = await agentFor('NAP-001')
    for (const who of [u.lucy, u.admin]) {
      await expect(edit(who, refund.id, `name = 'Renamed'`)).rejects.toThrow(/name, description, systems and data come from Northbridge Agent Platform \(simulated\)/)
      await expect(edit(who, refund.id, `data_classifications = '{public}'`)).rejects.toThrow(/come from/)
      await expect(edit(who, refund.id, `systems_accessed = '{X}'`)).rejects.toThrow(/come from/)
      await expect(edit(who, refund.id, `description = 'x'`)).rejects.toThrow(/come from/)
    }
  })

  it('governance fields stay editable, and saving a form that repeats the platform values is fine', async () => {
    const refund = await agentFor('NAP-001')
    await edit(u.lucy, refund.id, `purpose_statement = 'Issue customer refunds under £500', risk_tier = 'high', autonomy_level = 2`)
    await edit(u.lucy, refund.id, `name = $2, purpose_statement = 'Issue refunds under £500'`, [refund.name])
    expect((await db.query<{ p: string; r: string }>(`select purpose_statement p, risk_tier::text r from public.agents where id = $1`, [refund.id])).rows[0])
      .toEqual({ p: 'Issue refunds under £500', r: 'high' })
  })

  it('agents not on a platform keep every field editable', async () => {
    await edit(u.lucy, handMade, `name = 'Hand-made helper v2', data_classifications = '{public}'`)
    expect((await db.query<{ name: string }>(`select name from public.agents where id = $1`, [handMade])).rows[0].name).toBe('Hand-made helper v2')
  })

  it('a change on the platform reaches the registry at the next sync, even after approval', async () => {
    const refund = await agentFor('NAP-001')
    const reg = await asUser(db, u.lucy, async (tx) => (await tx.query<{ id: string }>(`select public.submit_agent_for_approval($1) id`, [refund.id])).rows[0].id)
    await asUser(db, u.omar, (tx) => tx.query(`select public.decide_registration($1, 'approve')`, [reg]))
    await asUser(db, u.lucy, (tx) => tx.query(`select public.go_live($1)`, [refund.id]))
    await sync([nap('NAP-001', 'Refund Processor v2', 'lucy.grant@northbridge.demo', 'Customer Service',
      { description: 'Now also handles chargebacks', dataClassifications: ['personal', 'confidential'], tools: ['Payments API', 'Cards API'] }), LIST[1]])
    expect(await agentFor('NAP-001')).toMatchObject({ status: 'live', name: 'Refund Processor v2', description: 'Now also handles chargebacks',
      systems_accessed: ['Cards API', 'Core banking', 'Payments API'], data: '{confidential,personal}' })
    // Its governance fields are untouched.
    expect((await db.query<{ p: string }>(`select purpose_statement p from public.agents where id = $1`, [refund.id])).rows[0].p).toBe('Issue refunds under £500')
    // A sync with nothing new writes nothing.
    const before = (await db.query<{ n: number }>(`select count(*)::int n from public.audit_events where entity_id = $1`, [refund.id])).rows[0].n
    await sync([nap('NAP-001', 'Refund Processor v2', 'lucy.grant@northbridge.demo', 'Customer Service',
      { description: 'Now also handles chargebacks', dataClassifications: ['personal', 'confidential'], tools: ['Payments API', 'Cards API'] }), LIST[1]])
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.audit_events where entity_id = $1`, [refund.id])).rows[0].n).toBe(before)
    expect((await db.query<{ broken: number }>(`select count(*)::int broken from public.audit_verify_chain()`)).rows[0].broken).toBe(0)
  })

  it('a retired agent is not changed by later syncs', async () => {
    await asUser(db, u.admin, (tx) => tx.query(`select public.retire_agent($1, 'Replaced')`, [invoiceMatcher]))
    await sync([LIST[0], nap('NAP-002', 'Invoice Matcher 2', 'james.whitfield@northbridge.demo', 'Payments')])
    expect((await db.query<{ name: string }>(`select name from public.agents where id = $1`, [invoiceMatcher])).rows[0].name).toBe('Invoice Matcher')
  })

  it('tells each person the source of the agents they can see', async () => {
    const sources = (who: string) => asUser(db, who, async (tx) => (await tx.query<{ external_id: string; platform: string }>(
      `select external_id, platform from public.agent_platform_sources() order by external_id`)).rows)
    expect(await sources(u.admin)).toEqual([{ external_id: 'NAP-001', platform: PLATFORM }, { external_id: 'NAP-002', platform: PLATFORM }])
    expect((await sources(u.lucy)).map((r) => r.external_id)).toEqual(['NAP-001'])
    expect((await sources(u.ravi)).map((r) => r.external_id)).toEqual(['NAP-002'])
  })
})
