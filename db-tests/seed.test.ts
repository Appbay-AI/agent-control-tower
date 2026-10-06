import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createDb, createUser } from './harness'

const SEED = readFileSync(path.resolve(__dirname, '../supabase/seed/02_demo_bank.sql'), 'utf8')
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
    expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toEqual({ live: 16, proposed: 4, retired: 1 })
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
  })

  it('can be run again without duplicating anything', async () => {
    const before = (await q<{ n: number }>(`select count(*)::int n from public.audit_events`))[0].n
    await db.exec(SEED)
    expect((await q<{ n: number }>(`select count(*)::int n from public.agents`))[0].n).toBe(21)
    // Only the alert refresh may run again, and it raises nothing new.
    expect((await q<{ n: number }>(`select count(*)::int n from public.audit_events`))[0].n).toBe(before)
  })
})
