// Acceptance checks for the Appian agent-platform simulator (appian/SIMULATOR_SPEC.md), run from GitHub Actions.
// Read-only except one reversible step: NAP-001 is quarantined through API 3 and then set back to active.
// Env: APPIAN_BASE (e.g. https://appbay-demo.appiancloud.com), APPIAN_API_KEY, GITHUB_STEP_SUMMARY.
import { appendFileSync } from 'node:fs'

const base = process.env.APPIAN_BASE?.replace(/\/$/, '') + '/suite/webapi'
const key = process.env.APPIAN_API_KEY ?? ''
const results = []
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`) }

async function call(path, { method = 'GET', body, apiKey = key } = {}) {
  const headers = { accept: 'application/json' }
  if (apiKey !== null) headers['Appian-API-Key'] = apiKey
  if (body) headers['content-type'] = 'application/json'
  const init = { method, headers }
  if (body) init.body = JSON.stringify(body)
  const res = await fetch(`${base}/${path}`, init)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, text, type: res.headers.get('content-type') ?? '' }
}

const AGENT_FIELDS = ['externalId', 'name', 'description', 'environment', 'status', 'statusChangedAt', 'statusChangedBy',
  'owner', 'department', 'dataSources', 'tools', 'dataClassifications', 'sharedWith', 'sessions30d', 'lastActiveAt',
  'createdAt', 'createdBy']
const LISTS = ['dataSources', 'tools', 'dataClassifications', 'sharedWith']
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const CLASSES = new Set(['public', 'internal', 'confidential', 'restricted', 'personal'])

async function main() {
  if (!key) { record('API key secret', false, 'APPIAN_API_KEY is not set in GitHub secrets'); return }

  // API 1
  const list = await call('nap-agents')
  const agents = list.json?.agents
  if (list.status !== 200 || !Array.isArray(agents)) {
    record('API 1 lists agents', false, `HTTP ${list.status}: ${list.text.slice(0, 200)}`)
    return
  }
  record('API 1 lists agents', true, `${agents.length} agents; content type ${list.type}`)
  const ids = agents.map((a) => a.externalId).sort()
  const want = ['NAP-001', 'NAP-002', 'NAP-003', 'NAP-004', 'NAP-005', 'NAP-006', 'NAP-007', 'NAP-008']
  record('API 1 returns the 8 seed agents', JSON.stringify(ids) === JSON.stringify(want), ids.join(', '))
  const problems = []
  for (const a of agents) {
    for (const f of AGENT_FIELDS) if (!(f in a)) problems.push(`${a.externalId} lacks ${f}`)
    for (const f of LISTS) if (!Array.isArray(a[f])) problems.push(`${a.externalId}.${f} is not a list`)
    if (!['active', 'quarantined'].includes(a.status)) problems.push(`${a.externalId}.status is "${a.status}"`)
    for (const f of ['statusChangedAt', 'createdAt']) if (a[f] && !ISO.test(a[f])) problems.push(`${a.externalId}.${f} "${a[f]}" is not ISO UTC`)
    if (a.owner !== null && (typeof a.owner !== 'object' || !a.owner.email)) problems.push(`${a.externalId}.owner is neither null nor {email,name}`)
    for (const c of a.dataClassifications ?? []) if (!CLASSES.has(c)) problems.push(`${a.externalId} has classification "${c}"`)
    for (const p of a.sharedWith ?? []) if (!p.email || !('jobTitle' in p) || !('department' in p)) problems.push(`${a.externalId} sharedWith entry lacks email/jobTitle/department`)
  }
  record('API 1 agent objects match the contract', problems.length === 0, problems.slice(0, 8).join('; ') || 'all fields present and well-formed')
  const byId = Object.fromEntries(agents.map((a) => [a.externalId, a]))
  record('Seed story: NAP-004 has no owner', byId['NAP-004']?.owner === null, `owner = ${JSON.stringify(byId['NAP-004']?.owner)}`)
  record('Seed story: NAP-003 shared with a Sales Associate', (byId['NAP-003']?.sharedWith ?? []).some((p) => /sales associate/i.test(p.jobTitle ?? '')),
    JSON.stringify(byId['NAP-003']?.sharedWith ?? []).slice(0, 160))

  // API 2
  const s7 = await call('nap-agent-status?externalId=NAP-007')
  record('API 2 reads NAP-007 as quarantined', s7.status === 200 && s7.json?.status === 'quarantined', `HTTP ${s7.status} ${s7.text.slice(0, 160)}`)
  const s999 = await call('nap-agent-status?externalId=NAP-999')
  record('API 2 answers 404 with an error for an unknown agent', s999.status === 404 && typeof s999.json?.error === 'string', `HTTP ${s999.status} ${s999.text.slice(0, 160)}`)

  // Security
  const noKey = await call('nap-agents', { apiKey: null })
  record('A call without the API key is refused', noKey.status === 401 || noKey.status === 403, `HTTP ${noKey.status}`)
  const badKey = await call('nap-agents', { apiKey: 'not-a-real-key' })
  record('A call with a wrong API key is refused', badKey.status === 401 || badKey.status === 403, `HTTP ${badKey.status}`)

  // API 3 (reversible)
  const bad = await call('nap-agent-status-set', { method: 'POST', body: { externalId: 'NAP-001', status: 'paused', reason: 'acceptance check', requestedBy: 'act-integration' } })
  record('API 3 refuses status "paused" with 400', bad.status === 400 && typeof bad.json?.error === 'string', `HTTP ${bad.status} ${bad.text.slice(0, 160)}`)
  const missing = await call('nap-agent-status-set', { method: 'POST', body: { externalId: 'NAP-999', status: 'quarantined', reason: 'acceptance check', requestedBy: 'act-integration' } })
  record('API 3 answers 404 for an unknown agent', missing.status === 404, `HTTP ${missing.status}`)

  const before = byId['NAP-001']?.status
  const q = await call('nap-agent-status-set', { method: 'POST', body: { externalId: 'NAP-001', status: 'quarantined', reason: 'Acceptance check from Agent Control Tower', requestedBy: 'act-integration' } })
  const read = await call('nap-agent-status?externalId=NAP-001')
  record('API 3 quarantines NAP-001 and API 2 reads it back', q.status === 200 && q.json?.status === 'quarantined' && read.json?.status === 'quarantined' && read.json?.statusChangedBy === 'act-integration',
    `set HTTP ${q.status}; read back ${read.text.slice(0, 160)}`)
  const again = await call('nap-agent-status-set', { method: 'POST', body: { externalId: 'NAP-001', status: 'quarantined', reason: 'Acceptance check repeat', requestedBy: 'act-integration' } })
  record('API 3 with the same status again returns 200 (safe retry)', again.status === 200 && again.json?.status === 'quarantined', `HTTP ${again.status}`)
  if (before === 'active') {
    const back = await call('nap-agent-status-set', { method: 'POST', body: { externalId: 'NAP-001', status: 'active', reason: 'Acceptance check finished: restoring', requestedBy: 'act-integration' } })
    record('NAP-001 restored to active', back.status === 200 && back.json?.status === 'active', `HTTP ${back.status}`)
  }
}

try { await main() } catch (e) { record('Run', false, e.message) }

const passed = results.filter((r) => r.ok).length
const md = ['## Appian simulator acceptance checks', '', `${passed} of ${results.length} passed`, '',
  '| Check | Result | Detail |', '|---|---|---|',
  ...results.map((r) => `| ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${String(r.detail).replace(/\|/g, '\\|')} |`),
  '', 'Not checked here (do by hand on the screens): the Activity feed shows NAP-001 blocked, "Switch back on" records the user, deleting NAP-008, Reset demo data.'].join('\n')
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
for (const r of results) console.log(`::${r.ok ? 'notice' : 'error'} title=${r.ok ? 'PASS' : 'FAIL'}: ${r.name}::${String(r.detail).slice(0, 300)}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
