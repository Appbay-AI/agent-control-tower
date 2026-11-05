// Task 3.1, resumed 5 Nov: "Connect Microsoft" and "Run Microsoft checks" (see migration 20261109000100_microsoft_connect.sql).
// The client secret and the renewable sign-in come from the database for one job at a time, are used here, and are
// never logged or returned to a browser.
import { rpc } from './api'

const PP = 'https://api.powerplatform.com'
const GRAPH = 'https://graph.microsoft.com'
const TIMEOUT_MS = 12_000

interface App { tenant_id: string; client_id: string; client_secret: string }
interface Tokens { access_token?: string; refresh_token?: string; id_token?: string; error?: string; error_description?: string }

/** Microsoft's token endpoint (form post). */
export async function tokenRequest(app: App, form: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<{ status: number; json: Tokens }> {
  const res = await fetchImpl(`https://login.microsoftonline.com/${app.tenant_id}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: app.client_id, client_secret: app.client_secret, ...form }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return { status: res.status, json: ((await res.json().catch(() => ({}))) as Tokens) }
}

/** The signed-in account from the ID token Microsoft just sent us over TLS (only read, not trusted for anything else). */
export function accountFromIdToken(idToken: string | undefined): { account: string; name: string } {
  try {
    const part = (idToken ?? '').split('.')[1] ?? ''
    const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))) as Record<string, string>
    return { account: claims.preferred_username ?? claims.upn ?? claims.email ?? '', name: claims.name ?? '' }
  } catch {
    return { account: '', name: '' }
  }
}

/** Microsoft's own error text, without the trace and correlation ids it appends. */
export function microsoftError(j: Tokens, status?: number): string {
  const text = (j.error_description ?? j.error ?? `HTTP ${status ?? '?'}`).split(/\r?\n/)[0].replace(/\s*Trace ID:.*$/, '')
  return text.slice(0, 300)
}

/**
 * The browser is back from Microsoft with a one-time code. Swap it for a renewable sign-in and store it.
 * Returns where to send the browser on our site.
 */
export async function finishSignIn(params: URLSearchParams, fetchImpl: typeof fetch = fetch): Promise<string> {
  const back = (outcome: 'connected' | 'error', reason?: string) =>
    `/integrations?microsoft=${outcome}${reason ? `&reason=${encodeURIComponent(reason.slice(0, 300))}` : ''}`
  const state = params.get('state') ?? ''
  if (params.get('error')) {
    return back('error', `Microsoft said: ${(params.get('error_description') ?? params.get('error') ?? '').split(/\r?\n/)[0].replace(/\s*Trace ID:.*$/, '')}`)
  }
  const code = params.get('code') ?? ''
  if (!/^mss_[0-9a-f]{64}$/.test(state) || !code) return back('error', 'The sign-in did not come back complete. Start again with Connect Microsoft.')

  const claimed = await rpc<App & { code_verifier: string; redirect_uri: string }>('microsoft_connect_claim', { p_state: state }, fetchImpl)
  if (!claimed.ok) {
    const j = (await claimed.response.json().catch(() => ({}))) as { message?: string }
    return back('error', j.message ?? 'This sign-in link has expired. Start again with Connect Microsoft.')
  }
  const c = claimed.data
  let t: { status: number; json: Tokens }
  try {
    t = await tokenRequest(c, { grant_type: 'authorization_code', code, redirect_uri: c.redirect_uri, code_verifier: c.code_verifier,
      scope: `${PP}/.default offline_access openid profile` }, fetchImpl)
  } catch (e) {
    return back('error', `Could not reach Microsoft: ${(e as Error).message}`)
  }
  if (t.status !== 200 || !t.json.refresh_token) {
    return back('error', t.status === 200 ? 'Microsoft did not return a renewable sign-in (offline access).' : `Microsoft refused the sign-in: ${microsoftError(t.json, t.status)}`)
  }
  const who = accountFromIdToken(t.json.id_token)
  const done = await rpc('microsoft_connect_finish', { p_state: state, p_refresh_token: t.json.refresh_token, p_account: who.account, p_name: who.name }, fetchImpl)
  if (!done.ok) return back('error', 'The sign-in worked but could not be stored. Try again.')
  return back('connected')
}

// ---------------------------------------------------------------------------
// The checks (what the Microsoft requirements rely on), run with the stored sign-in
// ---------------------------------------------------------------------------
export interface CheckResult { id: string; question: string; verdict: string; detail: string }
interface Claimed extends App { check: number; test_agent: string | null; refresh_token: string }

const trim = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function call(fetchImpl: typeof fetch, token: string, method: string, url: string, body?: unknown) {
  try {
    const res = await fetchImpl(url, {
      method, signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let json: Record<string, unknown> | null = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: `Could not reach Microsoft: ${(e as Error).message}` }
  }
}

export async function runChecks(c: Claimed, fetchImpl: typeof fetch = fetch, opts: { pauseMs?: number } = {}):
  Promise<{ results: CheckResult[]; refreshToken: string | null }> {
  const results: CheckResult[] = []
  const record = (id: string, question: string, verdict: string, detail: string) => results.push({ id, question, verdict, detail: trim(detail, 500) })
  const pause = opts.pauseMs ?? 3000
  let rt: string | null = null

  record('A1', 'Can an admin connect with one normal browser sign-in (MFA, consent), as security defaults require?', 'YES',
    'Connected through Connect Microsoft; the device-code sign-in the first test used is refused by this tenant.')

  // A2: renew without anyone signed in (what scheduled syncs depend on)
  const pp = await tokenRequest(c, { grant_type: 'refresh_token', refresh_token: c.refresh_token, scope: `${PP}/.default offline_access` }, fetchImpl)
    .catch((e: Error) => ({ status: 0, json: { error_description: e.message } as Tokens }))
  if (pp.status !== 200 || !pp.json.access_token) {
    record('A2', 'Does the stored sign-in renew without anyone present?', 'NO', `Renewal failed: ${microsoftError(pp.json, pp.status)}`)
    return { results, refreshToken: null }
  }
  rt = pp.json.refresh_token ?? null
  record('A2', 'Does the stored sign-in renew without anyone present?', 'YES', 'A new Power Platform token was issued from the stored sign-in, with nobody signed in.')
  const ppToken = pp.json.access_token

  // B: list Copilot Studio agents (Power Platform inventory)
  const q = await call(fetchImpl, ppToken, 'POST', `${PP}/resourcequery/resources/query?api-version=2024-10-01`, {
    TableName: 'PowerPlatformResources',
    Clauses: [{ $type: 'where', FieldName: 'type', Operator: '==', Values: ["'microsoft.copilotstudio/agents'"] }],
    Options: { Top: 1000, Skip: 0 },
  })
  type Agent = { name?: string; properties?: Record<string, unknown> }
  let agents: Agent[] = []
  if (q.status === 200 && q.json) {
    agents = (q.json.data as Agent[] | undefined) ?? []
    const fields = new Set<string>()
    for (const a of agents) for (const k of Object.keys(a.properties ?? {})) fields.add(k)
    record('B1', 'Can we list Copilot Studio agents (inventory)?', 'YES',
      `${agents.length} agent(s): ${agents.map((a) => String(a.properties?.displayName ?? a.name)).slice(0, 10).join(', ') || 'none'}. Properties seen: ${[...fields].sort().join(', ') || 'none'}.`)
    const want = ['ownerId', 'environmentId', 'isQuarantined', 'lastPublishedAt', 'sharedWithViewers', 'sharedWithEditors', 'channels', 'botId']
    const missing = want.filter((f) => !fields.has(f))
    record('B2', 'Does each agent carry owner, environment, blocked status, sharing and channels?', missing.length ? 'PARTLY' : 'YES',
      missing.length ? `Not present in this tenant's data: ${missing.join(', ')}.` : 'All expected fields present.')
  } else {
    record('B1', 'Can we list Copilot Studio agents (inventory)?', 'NO', `HTTP ${q.status}: ${trim(q.text)}`)
  }

  // C: blocked status, and block / unblock of the named test agent
  const test = c.test_agent?.trim() || null
  const pick = agents.find((a) => test && String(a.properties?.displayName ?? '').toLowerCase() === test.toLowerCase()) ?? (test ? undefined : agents[0])
  const envId = pick?.properties?.environmentId as string | undefined
  const botId = (pick?.properties?.botId as string | undefined) ?? pick?.name
  if (!pick || !envId || !botId) {
    record('C1', 'Can we read an agent\'s blocked (quarantine) status?', 'NOT TESTED',
      test ? `No agent named "${test}" in the list (new agents can take 15 to 20 minutes to appear).` : 'No agent with an environment and bot ID was found.')
  } else {
    const name = String(pick.properties?.displayName ?? botId)
    const base = `${PP}/copilotstudio/environments/${envId}/bots/${botId}/api/botQuarantine`
    const status = () => call(fetchImpl, ppToken, 'GET', `${base}?api-version=1`)
    const s0 = await status()
    record('C1', 'Can we read an agent\'s blocked (quarantine) status?', s0.status === 200 ? 'YES' : 'NO', `"${name}": HTTP ${s0.status} ${trim(s0.text, 200)}`)
    if (test) {
      const q1 = await call(fetchImpl, ppToken, 'POST', `${base}/SetAsQuarantined?api-version=1`, {})
      await sleep(pause)
      const s1 = await status()
      const blocked = q1.status < 300 && s1.json?.isBotQuarantined === true
      record('C2', 'Can we block (quarantine) an agent and confirm it by reading it back?', blocked ? 'YES' : 'NO',
        `Block: HTTP ${q1.status}${q1.status >= 300 ? ` ${trim(q1.text, 200)}` : ''}. Read back: ${trim(s1.text, 200)}`)
      const q2 = await call(fetchImpl, ppToken, 'POST', `${base}/SetAsUnquarantined?api-version=1`, {})
      await sleep(pause)
      const s2 = await status()
      record('C3', 'Can we unblock it again (reactivation after approval)?', q2.status < 300 && s2.json?.isBotQuarantined === false ? 'YES' : 'NO',
        `Unblock: HTTP ${q2.status}${q2.status >= 300 ? ` ${trim(q2.text, 200)}` : ''}. Read back: ${trim(s2.text, 200)}`)
      record('C4', 'Does blocking work on an agent that was never published (all a trial can make)?',
        pick.properties?.lastPublishedAt ? 'NOT TESTED' : blocked ? 'YES' : 'NO',
        pick.properties?.lastPublishedAt ? 'The test agent has been published.' : 'The test agent has never been published.')
    } else {
      record('C2', 'Can we block (quarantine) an agent and confirm it by reading it back?', 'NOT TESTED', 'No test agent named, so nothing was blocked.')
    }
  }

  // D: Microsoft Graph with the same sign-in
  const g = await tokenRequest(c, { grant_type: 'refresh_token', refresh_token: rt ?? c.refresh_token, scope: `${GRAPH}/.default offline_access` }, fetchImpl)
    .catch((e: Error) => ({ status: 0, json: { error_description: e.message } as Tokens }))
  if (g.status !== 200 || !g.json.access_token) {
    record('D1', 'Can the same sign-in read job title and department (Entra ID)?', 'NO', `Graph token failed: ${microsoftError(g.json, g.status)}`)
  } else {
    rt = g.json.refresh_token ?? rt
    const gt = g.json.access_token
    const users = await call(fetchImpl, gt, 'GET', `${GRAPH}/v1.0/users?$select=id,jobTitle,department&$top=20`)
    if (users.status === 200) {
      const list = (users.json?.value as { jobTitle?: string; department?: string }[] | undefined) ?? []
      record('D1', 'Can the same sign-in read job title and department (Entra ID)?', 'YES',
        `${list.length} user(s) read; ${list.filter((x) => x.jobTitle).length} with a job title, ${list.filter((x) => x.department).length} with a department.`)
    } else {
      record('D1', 'Can the same sign-in read job title and department (Entra ID)?', 'NO', `HTTP ${users.status}: ${trim(users.text)}`)
    }
    const p = await call(fetchImpl, gt, 'GET', `${GRAPH}/v1.0/copilot/admin/catalog/packages?$top=5`)
    record('D2', 'Can we read the Microsoft 365 agent registry (catalog)?', p.status === 200 ? 'YES' : 'NO',
      p.status === 200 ? `${((p.json?.value as unknown[]) ?? []).length} package(s) returned.` : `HTTP ${p.status}: ${trim(p.text, 200)}`)
    const a = await call(fetchImpl, gt, 'POST', `${GRAPH}/v1.0/security/auditLog/queries`, {
      displayName: 'Control Tower check: quarantine activity, last 7 days',
      filterStartDateTime: new Date(Date.now() - 7 * 864e5).toISOString(), filterEndDateTime: new Date().toISOString(), keywordFilter: 'Quarantine',
    })
    record('D3', 'Can we search the audit log (to find who unblocked an agent)?', a.status < 300 ? 'STARTED' : 'NO',
      a.status < 300 ? `Search started (ID ${String(a.json?.id ?? '?')}); results take minutes to hours.` : `HTTP ${a.status}: ${trim(a.text, 200)}`)
  }
  return { results, refreshToken: rt }
}

export async function runMicrosoftChecks(token: string, fetchImpl: typeof fetch = fetch, opts: { pauseMs?: number } = {}): Promise<CheckResult[] | null> {
  const claimed = await rpc<Claimed>('microsoft_check_claim', { p_token: token }, fetchImpl)
  if (!claimed.ok) return null
  let out: { results: CheckResult[]; refreshToken: string | null }
  try {
    out = await runChecks(claimed.data, fetchImpl, opts)
  } catch (e) {
    out = { results: [{ id: 'X', question: 'Run', verdict: 'ERROR', detail: (e as Error).message.slice(0, 300) }], refreshToken: null }
  }
  const verdicts = out.results.map((r) => r.verdict)
  const ok = !verdicts.includes('ERROR') && !(out.results.find((r) => r.id === 'A2')?.verdict === 'NO')
  const msg = `${out.results.length} checks: ${verdicts.filter((v) => v === 'YES').length} yes, ${verdicts.filter((v) => v === 'NO').length} no, ${verdicts.filter((v) => !['YES', 'NO'].includes(v)).length} other`
  await rpc('microsoft_check_report', { p_token: token, p_ok: ok, p_message: msg, p_results: out.results, p_refresh_token: out.refreshToken }, fetchImpl)
  return out.results
}
