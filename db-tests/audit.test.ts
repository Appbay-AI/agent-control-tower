import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, createDb, createDepartment, createUser, proposeAgent } from './harness'

describe('audit log (task 1.2)', () => {
  let db: PGlite
  let owner: string
  let admin: string
  let agentId: string

  beforeAll(async () => {
    db = await createDb()
    owner = await createUser(db, 'owner@bank.test', ['owner'])
    admin = await createUser(db, 'admin@bank.test', ['admin'])
    const dept = await createDepartment(db, 'Payments')
    agentId = await proposeAgent(db, owner, { department_id: dept })
    await asUser(db, owner, (tx) => tx.query(`update public.agents set description = 'Reads invoices' where id = $1`, [agentId]))
  })

  it('records every change automatically, with who did it and the before and after', async () => {
    const { rows } = await db.query<{ action: string; actor_id: string; actor_type: string; before: unknown; after: { description: string } }>(
      `select action, actor_id, actor_type, before, after from public.audit_events where agent_id = $1 order by seq`,
      [agentId],
    )
    expect(rows.map((r) => r.action)).toEqual(['agents.insert', 'agents.update'])
    expect(rows[0].actor_id).toBe(owner)
    expect(rows[0].actor_type).toBe('user')
    expect(rows[1].after.description).toBe('Reads invoices')
  })

  it('chains each row to the previous one, and the chain verifies', async () => {
    const { rows } = await db.query<{ seq: number; prev_hash: string; hash: string }>(
      `select seq, prev_hash, hash from public.audit_events order by seq`,
    )
    expect(rows[0].prev_hash).toBe('GENESIS')
    for (let i = 1; i < rows.length; i++) expect(rows[i].prev_hash).toBe(rows[i - 1].hash)
    const broken = await db.query(`select * from public.audit_verify_chain()`)
    expect(broken.rows).toEqual([])
  })

  it('refuses edits and deletes, even for the database owner', async () => {
    await expect(db.query(`update public.audit_events set reason = 'tampered' where seq = 1`)).rejects.toThrow(/insert-only/)
    await expect(db.query(`delete from public.audit_events where seq = 1`)).rejects.toThrow(/insert-only/)
    await expect(db.query(`truncate public.audit_events`)).rejects.toThrow(/insert-only/)
  })

  it('refuses direct inserts by signed-in users (only the system writes audit rows)', async () => {
    await expect(
      asUser(db, admin, (tx) =>
        tx.query(`insert into public.audit_events (actor_type, action, entity_type, prev_hash, hash, seq, occurred_at)
                  values ('user', 'fake', 'agents', 'x', 'y', 999, now())`),
      ),
    ).rejects.toThrow(/permission denied/)
  })

  it('detects tampering if someone bypasses the protection at the server level', async () => {
    const tampered = await createDb()
    const u = await createUser(tampered, 'o@bank.test', ['owner'])
    await proposeAgent(tampered, u)
    await proposeAgent(tampered, u, { name: 'Second' })
    // Simulate a superuser disabling the guard and rewriting history.
    await tampered.exec(`alter table public.audit_events disable trigger audit_events_no_update;
                         update public.audit_events set summary = 'rewritten' where seq = 2;`)
    const { rows } = await tampered.query<{ broken_seq: number }>(`select * from public.audit_verify_chain()`)
    expect(rows[0].broken_seq).toBe(2)
  })

  it('records autonomy changes as their own action for the evidence pack', async () => {
    await asUser(db, owner, (tx) => tx.query(`update public.agents set autonomy_level = 2 where id = $1`, [agentId]))
    const { rows } = await db.query<{ action: string; summary: string }>(
      `select action, summary from public.audit_events where agent_id = $1 order by seq desc limit 1`,
      [agentId],
    )
    expect(rows[0].action).toBe('agents.autonomy_changed')
    expect(rows[0].summary).toMatch(/level 1 → 2/)
  })
})
