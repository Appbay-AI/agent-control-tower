import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, proposeAgent } from './harness'

// Task 6.8: the audit view. Done when: any event can be found and exported. Entries are found by words, entry number,
// time, actor, agent and record type, a page at a time; each person only finds what the audit trail's rule lets them
// see; an export is itself recorded.
describe('audit search (task 6.8)', () => {
  let db: PGlite
  const u: Record<string, string> = {}
  const ag: Record<string, string> = {}
  type R = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const search = (who: string, args: Record<string, unknown> = {}) => asUser(db, who, async (tx) => {
    const names = ['p_query', 'p_from', 'p_to', 'p_actor_type', 'p_actor', 'p_agent', 'p_entity', 'p_action', 'p_before_seq', 'p_limit', 'p_full']
    const params = names.map((n) => args[n] ?? null)
    return (await tx.query<{ r: R }>(`select public.audit_search(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) r`, params)).rows[0].r
  })

  beforeAll(async () => {
    db = await createDb()
    const pay = await createDepartment(db, 'Payments')
    u.auditor = await createUser(db, 'auditor@bank.test', ['auditor'], 'Mei Lin')
    u.james = await createUser(db, 'james@bank.test', ['owner'], 'James Whitfield')
    u.tom = await createUser(db, 'tom@bank.test', ['owner'], 'Tom Becker')
    ag.james = await proposeAgent(db, u.james, { name: 'Payment Release Assistant', department_id: pay })
    ag.tom = await proposeAgent(db, u.tom, { name: 'Mail Room Router', department_id: pay })
    for (let i = 0; i < 5; i++) {
      await asUser(db, u.james, (tx) => tx.query(`update public.agents set purpose_statement = $2 where id = $1`, [ag.james, `Release payments, version ${i}`]))
    }
  })

  it('finds an entry by words, by its number, and by agent, record type and actor', async () => {
    const byName = await search(u.auditor, { p_query: 'mail room' })
    expect(byName.total).toBeGreaterThan(0)
    expect(byName.rows.every((r: R) => r.agent?.includes('Mail Room Router') || JSON.stringify(r).toLowerCase().includes('mail room'))).toBe(true)
    const one = byName.rows[0]
    const bySeq = await search(u.auditor, { p_query: `#${one.seq}` })
    expect(bySeq).toMatchObject({ total: 1, rows: [{ seq: one.seq, hash: one.hash, prev_hash: one.prev_hash }] })
    const byAgent = await search(u.auditor, { p_agent: ag.james, p_entity: 'agents' })
    expect(byAgent.total).toBe(6) // registered, then 5 changes
    expect(byAgent.rows[0]).toMatchObject({ actor: 'James Whitfield', actor_type: 'user', agent: expect.stringContaining('Payment Release Assistant') })
    expect(byAgent.rows[0].after.purpose_statement).toBe('Release payments, version 4')
    expect((await search(u.auditor, { p_actor: u.tom })).rows.every((r: R) => r.actor === 'Tom Becker')).toBe(true)
    // Words that are not there, and LIKE wildcards taken literally.
    expect((await search(u.auditor, { p_query: 'no such words anywhere' })).total).toBe(0)
    expect((await search(u.auditor, { p_query: '%' })).total).toBe(0)
  })

  it('a page at a time, newest first, and by date', async () => {
    const all = await search(u.auditor, { p_agent: ag.james, p_entity: 'agents' })
    const p1 = await search(u.auditor, { p_agent: ag.james, p_entity: 'agents', p_limit: 4 })
    expect(p1.rows.map((r: R) => r.seq)).toEqual(all.rows.slice(0, 4).map((r: R) => r.seq))
    const p2 = await search(u.auditor, { p_agent: ag.james, p_entity: 'agents', p_limit: 4, p_before_seq: p1.next_before_seq })
    expect(p2.rows.map((r: R) => r.seq)).toEqual(all.rows.slice(4).map((r: R) => r.seq))
    expect(p2.next_before_seq).toBeNull()
    const today = new Date().toISOString().slice(0, 10)
    expect((await search(u.auditor, { p_from: today, p_to: today })).total).toBeGreaterThan(0)
    expect((await search(u.auditor, { p_from: '2020-01-01', p_to: '2020-12-31' })).total).toBe(0)
  })

  it('each person finds only what they may see: James his agent, not Tom\'s', async () => {
    expect((await search(u.james, { p_query: 'Payment Release' })).total).toBeGreaterThan(0)
    expect((await search(u.james, { p_query: 'Mail Room' })).total).toBe(0)
    expect((await search(u.james, { p_agent: ag.tom })).total).toBe(0)
  })

  it('exports up to 10,000 entries with their values and hashes, and the export is on the record', async () => {
    const all = await search(u.auditor, { p_full: true, p_limit: 50000 })
    expect(all.limit).toBe(10000)
    expect(all.rows.length).toBe(all.total)
    const seq = await asUser(db, u.auditor, async (tx) =>
      (await tx.query<{ s: number }>(`select public.audit_record_export($1, $2, 'csv') s`, [{ query: 'everything' }, all.total])).rows[0].s)
    const rec = (await search(u.auditor, { p_query: `#${seq}` })).rows[0]
    expect(rec).toMatchObject({ action: 'audit.exported', actor: 'Mei Lin', summary: `Audit trail exported as CSV: ${all.total} entries` })
    expect((await db.query(`select * from public.audit_verify_chain()`)).rows).toEqual([])
    await expect(asUser(db, u.auditor, (tx) => tx.query(`select public.audit_record_export('{}', 1, 'pdf')`))).rejects.toThrow(/Unknown format/)
  })
})
