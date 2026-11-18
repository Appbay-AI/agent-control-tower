import { beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createDb } from './harness'

// The longer limits for the requests that may need them (18 Nov): one-click reports, and our site's background work.
describe('function time limits', () => {
  let db: PGlite
  beforeAll(async () => { db = await createDb() }, 120000)

  it('are set on the functions themselves', async () => {
    const rows = (await db.query<{ f: string; t: string }>(`
      select p.proname f, (select split_part(c, '=', 2) from unnest(p.proconfig) c where c like 'statement_timeout=%') t
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proconfig::text like '%statement_timeout%' order by 1`)).rows
    expect(rows).toEqual([
      { f: 'audit_search', t: '30s' }, { f: 'enforcement_report', t: '30s' }, { f: 'evidence_pack', t: '60s' },
      { f: 'platform_reconcile_apply', t: '30s' }, { f: 'platform_sync_apply', t: '30s' }, { f: 'push_report', t: '30s' },
    ])
  })
})
