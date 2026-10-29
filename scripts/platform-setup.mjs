// Task 3.2: stores the connection to the Appian agent-platform simulator in the database. Run by the Database
// migrations workflow after migrations. The API key comes from the GitHub secret APPIAN_API_KEY and goes straight from
// this runner into the database (platform_secrets, readable by no one); it is never printed or stored anywhere else.
// Usage: SUPABASE_DB_URL=... APPIAN_API_KEY=... [APPIAN_BASE=https://appbay-demo.appiancloud.com] node scripts/platform-setup.mjs
import { spawnSync } from 'node:child_process'

const dbUrl = process.env.SUPABASE_DB_URL
const key = process.env.APPIAN_API_KEY ?? ''
const base = (process.env.APPIAN_BASE || 'https://appbay-demo.appiancloud.com').replace(/\/+$/, '')
if (!dbUrl) throw new Error('SUPABASE_DB_URL is not set')
if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(base)) throw new Error('APPIAN_BASE must be an https site address, e.g. https://appbay-demo.appiancloud.com')

/** Runs SQL with psql; values are passed as psql variables, never pasted into the SQL text. */
function psql(sql, vars = {}) {
  const args = [dbUrl, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1']
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`)
  const r = spawnSync('psql', args, { input: sql, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || '').replace(/postgres(ql)?:\/\/\S+/g, 'postgresql://***').slice(0, 400)}`)
  return r.stdout.trim()
}

const state = psql(`select public.platform_configure('appian_simulator', 'Northbridge Agent Platform (simulated)', :'base', :'key');`, { base, key })
console.log(`Platforms: Northbridge Agent Platform (simulated) at ${base}: ${state}${key ? '' : ' (APPIAN_API_KEY is not set)'}`)
