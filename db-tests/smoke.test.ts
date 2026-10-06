import { describe, expect, it } from 'vitest'
import { createDb } from './harness'

describe('migrations', () => {
  it('apply cleanly to an empty database', async () => {
    const db = await createDb()
    const { rows } = await db.query<{ n: number }>(`select count(*)::int n from pg_tables where schemaname = 'public'`)
    expect(rows[0].n).toBeGreaterThanOrEqual(12)
  })
})
