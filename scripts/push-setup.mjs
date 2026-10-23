// Task 2.6: makes sure the database can send phone alerts. Run by the Database migrations workflow after migrations.
//   - Tells the database which site sends the alerts (dev or demo).
//   - Creates the VAPID signing key pair once, if the database has none. The private key goes straight from this
//     runner into the database (push_config, readable by no one); it is never printed or stored anywhere else.
// Usage: SUPABASE_DB_URL=... TARGET=dev|demo [SITE_URL=https://<preview>.agent-control-tower-56p.pages.dev] node scripts/push-setup.mjs   (ROTATE=true makes new keys; everyone
// then turns alerts on again.)
import { spawnSync } from 'node:child_process'
import { webcrypto } from 'node:crypto'

const SITES = {
  dev: 'https://main.agent-control-tower-56p.pages.dev',
  demo: 'https://agent-control-tower-56p.pages.dev',
}
const target = process.env.TARGET
// SITE_URL: point dev at a branch preview while testing it (the next normal run points it back).
const override = process.env.SITE_URL?.replace(/\/+$/, '')
if (override && !/^https:\/\/[a-z0-9-]+\.agent-control-tower-56p\.pages\.dev$/.test(override)) throw new Error('SITE_URL must be one of our pages.dev sites')
if (override && target !== 'dev') throw new Error('SITE_URL may only be used with TARGET=dev')
const site = override || SITES[target]
const dbUrl = process.env.SUPABASE_DB_URL
if (!site) throw new Error(`TARGET must be one of: ${Object.keys(SITES).join(', ')}`)
if (!dbUrl) throw new Error('SUPABASE_DB_URL is not set')

/** Runs SQL with psql; values are passed as psql variables, never pasted into the SQL text. */
function psql(sql, vars = {}) {
  const args = [dbUrl, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1']
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`)
  const r = spawnSync('psql', args, { input: sql, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || '').replace(/postgres(ql)?:\/\/\S+/g, 'postgresql://***').slice(0, 400)}`)
  return r.stdout.trim()
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

const existing = psql(`select coalesce((select vapid_public_key from public.push_config), '');`)
if (existing && process.env.ROTATE !== 'true') {
  console.log(psql(`select public.push_configure(:'site');`, { site }))
  console.log(`Alerts: keys already set (public key ${existing.slice(0, 12)}…); site ${site}`)
} else {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pub = b64url(await webcrypto.subtle.exportKey('raw', kp.publicKey))
  const { kty, crv, x, y, d } = await webcrypto.subtle.exportKey('jwk', kp.privateKey)
  console.log(psql(`select public.push_configure(:'site', :'pub', :'jwk'::jsonb, :'site');`,
    { site, pub, jwk: JSON.stringify({ kty, crv, x, y, d }) }))
  console.log(`Alerts: ${existing ? 'new' : 'first'} keys created (public key ${pub.slice(0, 12)}…); site ${site}`)
}
