import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createDb, createUser } from './harness'

const seedFile = (f: string) => readFileSync(path.resolve(__dirname, '../supabase/seed', f), 'utf8')
// psql runs these in one session; so does the test.
const SEED = ['00_helpers.sql', '02_demo_bank.sql', '03_more_agents.sql', '04_routing.sql', '05_action_requests.sql'].map(seedFile).join('\n')
const PERSONAS = ['admin', 'priya.sharma', 'ravi.menon', 'daniel.okafor', 'sara.haddad', 'omar.farouk',
  'james.whitfield', 'aisha.rahman', 'tom.becker', 'lucy.grant', 'mei.lin']

describe('Northbridge demo bank seed', () => {
  let db: PGlite
  const q = async <T,>(sql: string) => (await db.query<T>(sql)).rows

  beforeAll(async () => {
    db = await createDb()
    // 01_users.sql writes Supabase's auth tables; here the harness creates the same personas.
    for (const p of PERSONAS) await createUser(db, `${p}@northbridge.demo`)
    await db.exec(SEED)
  }, 120000)

  it('creates the registry with every lifecycle state', async () => {
    const rows = await q<{ status: string; n: number }>(`select status::text, count(*)::int n from public.agents group by 1 order by 1`)
    expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toEqual({ live: 33, proposed: 6, retired: 1 })
  })

  it('loads the demo routing rules once, however often it runs', async () => {
    await db.exec(seedFile('04_routing.sql'))
    const rules = await q<{ name: string; approver: string }>(
      `select r.name, p.email approver from public.routing_rules r join public.profiles p on p.id = r.approver_id order by r.priority`)
    expect(rules).toEqual([
      { name: 'Large payments (£1m and above)', approver: 'ravi.menon@northbridge.demo' },
      { name: 'Agents that touch personal data', approver: 'omar.farouk@northbridge.demo' },
    ])
  })

  it('leaves the £2m payment waiting in Ravi\'s queue (four-eyes) and three rotas with Omar, once however often it runs', async () => {
    await db.exec(seedFile('00_helpers.sql') + seedFile('05_action_requests.sql'))
    const rows = await q<{ agent: string; status: string; amount: string | null; assignee: string; required: number; days_left: number; live_keys: number }>(`
      select a.name agent, r.status::text, r.amount::text, p.email assignee, r.required_approvals required,
             round(extract(epoch from r.due_at - now()) / 86400)::int days_left,
             (select count(*)::int from public.agent_api_keys k where k.agent_id = r.agent_id and k.revoked_at is null) live_keys
      from public.action_requests r join public.profiles p on p.id = r.assigned_to join public.agents a on a.id = r.agent_id
      order by a.name, r.description`)
    expect(rows).toEqual([
      ...['Bristol', 'Leeds', 'Manchester'].map(() => ({ agent: 'Branch Rota Planner', status: 'pending', amount: null,
        assignee: 'omar.farouk@northbridge.demo', required: 1, days_left: 3, live_keys: 0 })),
      { agent: 'Payment Release Assistant', status: 'pending', amount: '2000000.00', assignee: 'ravi.menon@northbridge.demo',
        required: 2, days_left: 3, live_keys: 0 },
    ])
    const hold = await q<{ h: string }>(`select hold_reason h from public.action_requests where amount = 2000000`)
    expect(hold[0].h).toMatch(/outside its limits/)
  })

  it('tells the story: six live agents without owners, four overdue reviews, one shadow agent', async () => {
    expect((await q<{ n: number }>(`select count(*)::int n from public.agents where status = 'live' and business_owner_id is null`))[0].n).toBe(6)
    const alerts = await q<{ kind: string; n: number }>(
      `select kind::text, count(*)::int n from public.alerts where resolved_at is null group by 1 order by 1`)
    expect(Object.fromEntries(alerts.map((a) => [a.kind, a.n]))).toEqual({ owner_missing: 6, review_overdue: 4 })
    const shadow = await q<{ registration_source: string; business_owner_id: string | null }>(
      `select registration_source, business_owner_id from public.agents where name = 'Copilot for Ops Tickets'`)
    expect(shadow[0]).toEqual({ registration_source: 'discovered', business_owner_id: null })
  })

  it('leaves work in the approval queues, including a four-eyes approval half done', async () => {
    const pending = await q<{ name: string; required_approvals: number; approvals: number }>(`
      select a.name, r.required_approvals,
             (select count(*)::int from public.registration_decisions d where d.registration_id = r.id and d.decision = 'approve') approvals
      from public.agent_registrations r join public.agents a on a.id = r.agent_id
      where r.status = 'pending' order by a.name`)
    expect(pending).toEqual([
      { name: 'Cloud Cost Optimiser', required_approvals: 1, approvals: 0 },
      { name: 'FX Payment Router', required_approvals: 2, approvals: 1 },
      { name: 'Supplier Onboarding Bot', required_approvals: 1, approvals: 0 },
    ])
    const sentBack = await q<{ status: string }>(`
      select r.status::text from public.agent_registrations r join public.agents a on a.id = r.agent_id
      where a.name = 'Mortgage Pre-qualifier'`)
    expect(sentBack[0].status).toBe('sent_back')
  })

  it('names the real personas in the audit trail, and the chain verifies', async () => {
    const who = await q<{ full_name: string }>(`
      select p.full_name from public.audit_events e join public.profiles p on p.id = e.actor_id
      where e.action = 'agents.status_changed' and e.summary like 'AGT-0001: proposed → approved'`)
    expect(who[0].full_name).toBe('ravi.menon')
    expect(await q(`select * from public.audit_verify_chain()`)).toEqual([])
    const daniel = await q<{ is_active: boolean; roles: string; scopes: number }>(`
      select p.is_active, (select string_agg(role::text, ',') from public.user_roles where user_id = p.id) roles,
             (select count(*)::int from public.approver_scopes where user_id = p.id) scopes
      from public.profiles p where email = 'daniel.okafor@northbridge.demo'`)
    expect(daniel[0]).toEqual({ is_active: true, roles: 'approver', scopes: 2 })
  })

  it('spreads history over the past year, with completed reviews', async () => {
    const span = await q<{ oldest: number; reviews: number }>(`
      select (current_date - min(created_at)::date) oldest, (select count(*)::int from public.agent_reviews) reviews
      from public.agents`)
    expect(span[0].oldest).toBeGreaterThan(365)
    expect(span[0].reviews).toBe(10)
  })

  it('can be run again without duplicating anything', async () => {
    const before = (await q<{ n: number }>(`select count(*)::int n from public.audit_events`))[0].n
    await db.exec(SEED)
    expect((await q<{ n: number }>(`select count(*)::int n from public.agents`))[0].n).toBe(40)
    // Only the alert refresh may run again, and it raises nothing new.
    expect((await q<{ n: number }>(`select count(*)::int n from public.audit_events`))[0].n).toBe(before)
  })

  it('can be reset and reloaded to exactly the same story, with a fresh audit chain', async () => {
    // Something done to a persona during a demo: Daniel deactivated and stripped of his roles.
    await db.exec(`
      update public.profiles set is_active = false where email = 'daniel.okafor@northbridge.demo';
      delete from public.user_roles where user_id = (select id from public.profiles where email = 'daniel.okafor@northbridge.demo');
      delete from public.approver_scopes where user_id = (select id from public.profiles where email = 'daniel.okafor@northbridge.demo');`)
    await db.exec(seedFile('90_reset.sql'))
    expect((await q<{ n: number }>(`select count(*)::int n from public.agents`))[0].n).toBe(0)
    expect((await q<{ n: number }>(`select count(*)::int n from public.audit_events`))[0].n).toBe(0)
    await db.exec(SEED)
    expect((await q<{ n: number }>(`select count(*)::int n from public.agents`))[0].n).toBe(40)
    expect((await q<{ c: string }>(`select agent_code c from public.agents where name = 'Payment Release Assistant'`))[0].c).toBe('AGT-0001')
    expect(await q(`select * from public.audit_verify_chain()`)).toEqual([])
    const daniel = await q<{ is_active: boolean; roles: string; scopes: number }>(`
      select p.is_active, (select string_agg(role::text, ',') from public.user_roles where user_id = p.id) roles,
             (select count(*)::int from public.approver_scopes where user_id = p.id) scopes
      from public.profiles p where email = 'daniel.okafor@northbridge.demo'`)
    expect(daniel[0]).toEqual({ is_active: true, roles: 'approver', scopes: 2 })
    // The guards are back on after the reset.
    await expect(db.query(`delete from public.audit_events where seq = 1`)).rejects.toThrow(/insert-only/)
  })
})
