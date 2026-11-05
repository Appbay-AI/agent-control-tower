import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Supabase refuses UPDATE and DELETE without a WHERE clause on requests through its web API (pg_safeupdate), which is
// how the app and our Cloudflare API call the database. The test database (PGlite) has no such guard, so this checks
// the latest version of every database function instead. Found on 5 Nov: the Microsoft checks' report was refused.

// Run only by the Database migrations workflow (psql), where the guard does not apply.
const SETUP_ONLY = new Set(['push_configure', 'email_configure', 'platform_configure', 'microsoft_configure'])

describe('no UPDATE or DELETE without WHERE in functions the API can reach', () => {
  it('every such statement names its rows', () => {
    const dir = join(__dirname, '..', 'supabase', 'migrations')
    const latest = new Map<string, { file: string; body: string }>()
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(dir, file), 'utf8')
      for (const m of sql.matchAll(/create (?:or replace )?function public\.(\w+)\([\s\S]*?\$\$([\s\S]*?)\$\$/gi)) {
        latest.set(m[1], { file, body: m[2] })
      }
    }
    const bad: string[] = []
    for (const [name, { file, body }] of latest) {
      if (SETUP_ONLY.has(name)) continue
      for (const st of body.matchAll(/\b(update\s+public\.\w+\s+set\b|delete\s+from\s+public\.\w+)[^;]*;/gi)) {
        if (!/\bwhere\b/i.test(st[0])) bad.push(`${name} (${file}): ${st[0].replace(/\s+/g, ' ').slice(0, 100)}`)
      }
    }
    expect(bad).toEqual([])
  })
})
