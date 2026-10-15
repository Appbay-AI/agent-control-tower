// Microsoft spike (build plan task 3.1): checks, against a real tenant, what the Phase 2 requirements rely on.
// Run by .github/workflows/ms-spike.yml. Sign-in is by device code: the person opens microsoft.com/devicelogin
// and types the code shown in the workflow run. Tokens are kept in memory only and never printed.
//
// Env: MS_TENANT_ID, MS_CLIENT_ID (both identifiers, not secrets), TEST_AGENT (optional display name of an agent
// that may be quarantined and unquarantined), AUDIT_QUERY_ID (optional, reads a previous audit search),
// GITHUB_STEP_SUMMARY (set by GitHub).

import { appendFileSync } from 'node:fs'

const tenant = process.env.MS_TENANT_ID?.trim()
const clientId = process.env.MS_CLIENT_ID?.trim()
const testAgent = process.env.TEST_AGENT?.trim() || ''
const summaryFile = process.env.GITHUB_STEP_SUMMARY
const PP = 'https://api.powerplatform.com'
const GRAPH = 'https://graph.microsoft.com'

if (!tenant || !clientId) {
  console.error('MS_TENANT_ID and MS_CLIENT_ID are required.')
  process.exit(1)
}

const results = []
function record(id, question, verdict, detail) {
  results.push({ id, question, verdict, detail })
  console.log(`[${verdict}] ${id} ${question}\n    ${detail}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const trim = (s, n = 300) => (s.length > n ? s.slice(0, n) + '…' : s)

// ---------------------------------------------------------------------------
// Sign-in: device code flow (delegated, as Microsoft requires for these APIs)
// ---------------------------------------------------------------------------
const authority = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`

async function form(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

async function signIn() {
  const dc = await form(`${authority}/devicecode`, { client_id: clientId, scope: `${PP}/.default offline_access` })
  if (dc.status !== 200) throw new Error(`Device code request failed: ${dc.json.error_description ?? dc.status}`)
  // Shown in the log and as an annotation on the run page.
  console.log(`\n::notice title=Sign in now::Open ${dc.json.verification_uri} and enter the code ${dc.json.user_code} (valid ${Math.round(dc.json.expires_in / 60)} minutes). Sign in as the tenant admin.\n`)
  const deadline = Date.now() + dc.json.expires_in * 1000
  let interval = (dc.json.interval ?? 5) * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    const t = await form(`${authority}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: dc.json.device_code,
    })
    if (t.status === 200) return t.json
    if (t.json.error === 'authorization_pending') continue
    if (t.json.error === 'slow_down') { interval += 5000; continue }
    throw new Error(`Sign-in failed: ${t.json.error_description ?? t.json.error}`)
  }
  throw new Error('Sign-in timed out: the code was not entered in time.')
}

async function refresh(refreshToken, scope) {
  return form(`${authority}/token`, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, scope })
}

async function call(token, method, url, body) {
  const init = { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(url, init)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, text }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function main() {
  const first = await signIn()
  const ppToken = first.access_token
  record('A1', 'Can a tenant admin grant access with a one-time sign-in (device code)?', 'YES', 'Signed in and received a Power Platform API token.')

  // A2: background renewal without the person (what the 5-minute sync depends on)
  let refreshToken = first.refresh_token
  if (!refreshToken) {
    record('A2', 'Does Microsoft issue a renewable sign-in (refresh token) for unattended use?', 'NO', 'No refresh token returned; offline_access may be blocked.')
  } else {
    const r = await refresh(refreshToken, `${PP}/.default offline_access`)
    if (r.status === 200) {
      refreshToken = r.json.refresh_token ?? refreshToken
      record('A2', 'Does Microsoft issue a renewable sign-in (refresh token) for unattended use?', 'YES', 'A new Power Platform token was obtained from the refresh token, with nobody signed in.')
    } else {
      record('A2', 'Does Microsoft issue a renewable sign-in (refresh token) for unattended use?', 'NO', `Refresh failed: ${r.json.error_description ?? r.status}`)
    }
  }

  // B1: inventory API
  const q = await call(ppToken, 'POST', `${PP}/resourcequery/resources/query?api-version=2024-10-01`, {
    TableName: 'PowerPlatformResources',
    Clauses: [{ $type: 'where', FieldName: 'type', Operator: '==', Values: ["'microsoft.copilotstudio/agents'"] }],
    Options: { Top: 1000, Skip: 0 },
  })
  let agents = []
  if (q.status === 200 && q.json) {
    agents = q.json.data ?? []
    const fields = new Set()
    for (const a of agents) for (const k of Object.keys(a.properties ?? {})) fields.add(k)
    record('B1', 'Can we list Copilot Studio agents through the inventory API?', 'YES',
      `${agents.length} agent(s) returned (totalRecords ${q.json.totalRecords ?? '?'}). Properties seen: ${[...fields].sort().join(', ') || 'none'}.`)
    const want = ['ownerId', 'environmentId', 'isQuarantined', 'lastPublishedAt', 'sharedWithViewers', 'sharedWithEditors', 'channels', 'botId']
    const missing = want.filter((f) => !fields.has(f))
    record('B2', 'Does each agent carry owner, environment, blocked status, sharing and channels?', missing.length ? 'PARTLY' : 'YES',
      missing.length ? `Not present in this tenant's data: ${missing.join(', ')}.` : 'All expected fields present.')
    const sharing = agents.map((a) => a.properties?.sharedWithViewers).find((v) => v !== undefined)
    record('B3', 'Is sharing returned as a list of people or groups, or only as a count/flag?', sharing === undefined ? 'UNKNOWN' : 'SEE DETAIL',
      sharing === undefined ? 'No agent had sharing data.' : `Example shape: ${trim(JSON.stringify(sharing), 200)}`)
  } else {
    record('B1', 'Can we list Copilot Studio agents through the inventory API?', 'NO', `HTTP ${q.status}: ${trim(q.text)}`)
  }

  // C: quarantine API (status read; optional block/unblock of a named test agent)
  const pick = agents.find((a) => testAgent && a.properties?.displayName === testAgent) ?? agents[0]
  const envId = pick?.properties?.environmentId
  const botId = pick?.properties?.botId ?? pick?.name
  if (!pick || !envId || !botId) {
    record('C1', 'Can we read an agent\'s blocked (quarantine) status?', 'NOT TESTED', 'No agent with environment and bot ID was found.')
  } else {
    const base = `${PP}/copilotstudio/environments/${envId}/bots/${botId}/api/botQuarantine`
    const status = async () => {
      let s = await call(ppToken, 'GET', `${base}?api-version=1`)
      if (s.status === 404) s = await call(ppToken, 'GET', `${base}/GetBotQuarantineStatus?api-version=1`)
      return s
    }
    const s0 = await status()
    record('C1', 'Can we read an agent\'s blocked (quarantine) status?', s0.status === 200 ? 'YES' : 'NO',
      `Agent "${pick.properties?.displayName}": HTTP ${s0.status} ${trim(s0.text, 200)}`)

    if (testAgent && pick.properties?.displayName === testAgent) {
      const q1 = await call(ppToken, 'POST', `${base}/SetAsQuarantined?api-version=1`, {})
      await sleep(3000)
      const s1 = await status()
      record('C2', 'Can we block (quarantine) an agent and confirm it with a read-back?', q1.status < 300 && /true/i.test(s1.text) ? 'YES' : 'NO',
        `Block: HTTP ${q1.status}. Read-back: ${trim(s1.text, 200)}`)
      const q2 = await call(ppToken, 'POST', `${base}/SetAsUnquarantined?api-version=1`, {})
      await sleep(3000)
      const s2 = await status()
      record('C3', 'Can we unblock it again (reactivation after approval)?', q2.status < 300 && /false/i.test(s2.text) ? 'YES' : 'NO',
        `Unblock: HTTP ${q2.status}. Read-back: ${trim(s2.text, 200)}`)
      record('C4', 'Does blocking work on an unpublished agent (all a free trial can make)?',
        pick.properties?.lastPublishedAt ? 'NOT TESTED' : (q1.status < 300 ? 'YES' : 'NO'),
        pick.properties?.lastPublishedAt ? 'The test agent is published.' : 'The test agent has never been published.')
    } else {
      record('C2', 'Can we block (quarantine) an agent and confirm it with a read-back?', 'NOT TESTED', 'No test agent named, so nothing was blocked. Re-run with a test agent name to try it.')
    }
  }

  // D: Microsoft Graph with the same sign-in (refresh token for another resource)
  const g = refreshToken ? await refresh(refreshToken, `${GRAPH}/.default`) : { status: 0, json: {} }
  if (g.status !== 200) {
    record('D1', 'Can the same sign-in read job title and department from Entra ID?', 'NO', `Graph token failed: ${g.json.error_description ?? g.status}`)
  } else {
    const gt = g.json.access_token
    const u = await call(gt, 'GET', `${GRAPH}/v1.0/users?$select=id,jobTitle,department&$top=20`)
    if (u.status === 200) {
      const list = u.json.value ?? []
      record('D1', 'Can the same sign-in read job title and department from Entra ID?', 'YES',
        `${list.length} user(s) read; ${list.filter((x) => x.jobTitle).length} with a job title, ${list.filter((x) => x.department).length} with a department.`)
    } else {
      record('D1', 'Can the same sign-in read job title and department from Entra ID?', 'NO', `HTTP ${u.status}: ${trim(u.text)}`)
    }
    const p = await call(gt, 'GET', `${GRAPH}/v1.0/copilot/admin/catalog/packages?$top=5`)
    record('D2', 'Can we read the Microsoft 365 agent registry (catalog packages)?', p.status === 200 ? 'YES' : 'NO',
      p.status === 200 ? `${(p.json.value ?? []).length} package(s) returned.` : `HTTP ${p.status}: ${trim(p.text, 200)}`)
    const auditId = process.env.AUDIT_QUERY_ID?.trim()
    if (!auditId) {
      const a = await call(gt, 'POST', `${GRAPH}/v1.0/security/auditLog/queries`, {
        displayName: 'ACT spike: quarantine activity, last 7 days',
        filterStartDateTime: new Date(Date.now() - 7 * 864e5).toISOString(),
        filterEndDateTime: new Date().toISOString(),
        keywordFilter: 'Quarantine',
      })
      record('D3', 'Can we search the audit log (to find who unblocked an agent)?', a.status < 300 ? 'STARTED' : 'NO',
        a.status < 300 ? `Search started (ID ${a.json?.id}). Results take minutes to hours: re-run this workflow with this ID in "audit_query_id".`
          : `HTTP ${a.status}: ${trim(a.text, 200)}`)
    } else {
      const st = await call(gt, 'GET', `${GRAPH}/v1.0/security/auditLog/queries/${auditId}`)
      const recs = await call(gt, 'GET', `${GRAPH}/v1.0/security/auditLog/queries/${auditId}/records?$top=100`)
      if (recs.status === 200) {
        const rows = recs.json.value ?? []
        const ops = [...new Set(rows.map((r) => r.operation))]
        const withUser = rows.filter((r) => r.userPrincipalName || r.userId).length
        record('D3', 'Does the audit log record who blocked or unblocked an agent?', rows.length ? 'SEE DETAIL' : 'NO RECORDS',
          `Search status: ${st.json?.status ?? '?'}. ${rows.length} record(s); operations: ${ops.join(', ') || 'none'}; ${withUser} with a user.`)
      } else {
        record('D3', 'Does the audit log record who blocked or unblocked an agent?', 'NO', `HTTP ${recs.status}: ${trim(recs.text, 200)}`)
      }
    }
  }
}

try {
  await main()
} catch (e) {
  record('X', 'Run', 'ERROR', e.message)
}

const md = ['## Microsoft feasibility spike', '', `Tenant ${tenant.slice(0, 8)}… · ${new Date().toISOString()}`, '',
  '| # | Question | Result | Detail |', '|---|---|---|---|',
  ...results.map((r) => `| ${r.id} | ${r.question} | **${r.verdict}** | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)].join('\n')
if (summaryFile) appendFileSync(summaryFile, md + '\n')
for (const r of results) console.log(`::notice title=${r.id} ${r.verdict}::${r.question} ${trim(r.detail, 400)}`)
