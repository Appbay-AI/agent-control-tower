// Task 3.1 (resumed): stores the Microsoft app registration in the database (microsoft_app, readable by no one). Run by
// the Database migrations workflow after migrations. The IDs come from the GitHub variables MS_TENANT_ID and
// MS_CLIENT_ID, the client secret from the GitHub secret MS_CLIENT_SECRET; the secret is never printed.
// Usage: SUPABASE_DB_URL=... MS_TENANT_ID=... MS_CLIENT_ID=... [MS_CLIENT_SECRET=...] node scripts/microsoft-setup.mjs
import { spawnSync } from 'node:child_process'

const dbUrl = process.env.SUPABASE_DB_URL
const tenant = (process.env.MS_TENANT_ID ?? '').trim()
const client = (process.env.MS_CLIENT_ID ?? '').trim()
const secret = process.env.MS_CLIENT_SECRET ?? ''
if (!dbUrl) throw new Error('SUPABASE_DB_URL is not set')
if (!tenant || !client) {
  console.log('Microsoft: not set up (GitHub variables MS_TENANT_ID and MS_CLIENT_ID are not set)')
  process.exit(0)
}
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
if (!guid.test(tenant) || !guid.test(client)) throw new Error('MS_TENANT_ID and MS_CLIENT_ID must be IDs like 7535ea2c-3e9b-42b7-b942-d208757b8bb9')

const r = spawnSync('psql', [dbUrl, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-v', `tenant=${tenant}`, '-v', `client=${client}`, '-v', `secret=${secret}`],
  { input: `select public.microsoft_configure(:'tenant', :'client', :'secret');`, encoding: 'utf8' })
if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || '').replace(/postgres(ql)?:\/\/\S+/g, 'postgresql://***').slice(0, 400)}`)
console.log(`Microsoft: app ${client.slice(0, 8)}… in tenant ${tenant.slice(0, 8)}…: ${r.stdout.trim()}${secret ? '' : ' (MS_CLIENT_SECRET is not set)'}`)
