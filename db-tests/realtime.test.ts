import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createDb } from './harness'

// Task 2.5: the tables behind the approvals list are published to Supabase Realtime.
describe('live approvals (task 2.5)', () => {
  let db: PGlite
  const LIVE_TABLES = ['action_requests', 'agent_registrations', 'notifications', 'registration_decisions'] // notifications: task 5.4

  beforeAll(async () => {
    db = await createDb()
  })

  async function published() {
    const { rows } = await db.query<{ tablename: string }>(
      `select tablename from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by 1`)
    return rows.map((r) => r.tablename)
  }

  it('publishes the approval tables, and nothing else', async () => {
    expect(await published()).toEqual([...LIVE_TABLES].sort())
  })

  it('only publishes tables that row-level security protects and signed-in people may read', async () => {
    for (const t of LIVE_TABLES) {
      const { rows } = await db.query<{ rls: boolean; can_read: boolean }>(
        `select c.relrowsecurity as rls, has_table_privilege('authenticated', c.oid, 'select') as can_read
           from pg_catalog.pg_class c where c.oid = ('public.' || $1)::regclass`, [t])
      expect(rows[0], t).toEqual({ rls: true, can_read: true })
      // Anonymous visitors get nothing.
      const anon = await db.query<{ ok: boolean }>(`select has_table_privilege('anon', ('public.' || $1)::regclass, 'select') ok`, [t])
      expect(anon.rows[0].ok, t).toBe(false)
    }
  })

  it('can run again without error (e.g. a table already switched on in the dashboard)', async () => {
    const sql = readFileSync(path.resolve(__dirname, '../supabase/migrations/20261023000100_realtime_approvals.sql'), 'utf8')
    await db.exec(`alter publication supabase_realtime drop table public.agent_registrations`)
    await db.exec(sql)
    await db.exec(sql)
    expect(await published()).toEqual([...LIVE_TABLES].sort())
    // Task 5.4's step too.
    const n = readFileSync(path.resolve(__dirname, '../supabase/migrations/20261121000100_notifications.sql'), 'utf8')
    const step = n.slice(n.indexOf('do $$'), n.indexOf('end $$;', n.indexOf('do $$')) + 'end $$;'.length)
    await db.exec(step)
    expect(await published()).toEqual([...LIVE_TABLES].sort())
  })
})
