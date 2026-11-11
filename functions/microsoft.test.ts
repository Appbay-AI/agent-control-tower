// @vitest-environment node
// Task 3.1 (resumed): Connect Microsoft and the Microsoft checks, against a stand-in Microsoft and database.
import { describe, expect, it, vi } from 'vitest'
import { accountFromIdToken, finishSignIn, microsoftError, runMicrosoftChecks } from '../functions-lib/microsoft'

const STATE = 'mss_' + 'a'.repeat(64)
const TOKEN = 'mct_' + 'b'.repeat(64)
const app = { tenant_id: 't-1', client_id: 'c-1', client_secret: 'shh' }
const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

/** A stand-in for the database (rpc) and Microsoft. `quarantined` follows block / unblock calls. */
function world(opts: { tokenStatus?: number; noRefresh?: boolean; claimFails?: boolean; agents?: object[]; blockStatus?: number; slowListMs?: number; startBlocked?: boolean } = {}) {
  const rpcs: { fn: string; body: Record<string, unknown> }[] = []
  const forms: URLSearchParams[] = []
  let quarantined = opts.startBlocked ?? false
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const rpcName = url.match(/\/rest\/v1\/rpc\/(\w+)$/)?.[1]
    if (rpcName) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      rpcs.push({ fn: rpcName, body })
      if (rpcName === 'microsoft_connect_claim') {
        return opts.claimFails ? reply(400, { code: '28000', message: 'This sign-in link has expired or was already used.' })
          : reply(200, { ...app, code_verifier: 'v'.repeat(64), redirect_uri: 'https://main.example.dev/api/v1/microsoft/callback' })
      }
      if (rpcName === 'microsoft_check_claim') return reply(200, { ...app, check: 7, test_agent: 'Control Tower Test Agent', refresh_token: 'rt-0' })
      return reply(200, null)
    }
    if (url.endsWith('/oauth2/v2.0/token')) {
      const form = new URLSearchParams(String(init?.body))
      forms.push(form)
      if (opts.tokenStatus && opts.tokenStatus !== 200) return reply(opts.tokenStatus, { error: 'invalid_grant', error_description: 'AADSTS70008: The code expired.\r\nTrace ID: abc' })
      return reply(200, { access_token: `at-${forms.length}`, refresh_token: opts.noRefresh ? undefined : `rt-${forms.length}`,
        id_token: idToken({ preferred_username: 'arpit@tenant.test', name: 'Arpit Khandelwal' }) })
    }
    if (url.includes('/resourcequery/')) {
      if (opts.slowListMs) await new Promise((r) => setTimeout(r, opts.slowListMs))
      return reply(200, { totalRecords: 1, data: opts.agents ?? [{ name: 'bot-1', properties: { displayName: 'Control Tower Test Agent', environmentId: 'env-1',
        botId: 'bot-1', ownerId: 'u1', isQuarantined: false } }] })
    }
    if (url.includes('/botQuarantine/SetAsQuarantined')) { if (!opts.blockStatus) quarantined = true; return reply(opts.blockStatus ?? 200, {}) }
    if (url.includes('/botQuarantine/SetAsUnquarantined')) { quarantined = false; return reply(200, {}) }
    if (url.includes('/botQuarantine?')) return reply(200, { isBotQuarantined: quarantined, lastUpdateTimeUtc: '2026-11-05T09:00:00Z' })
    if (url.includes('/v1.0/users')) return reply(200, { value: [{ id: '1', jobTitle: 'CTO', department: 'IT' }, { id: '2' }] })
    if (url.includes('/catalog/packages')) return reply(403, { error: { message: 'Forbidden' } })
    if (url.includes('/auditLog/queries')) return reply(201, { id: 'q-1' })
    return reply(404, {})
  }) as unknown as typeof fetch
  return { fetchImpl, rpcs, forms, isBlocked: () => quarantined }
}

describe('Connect Microsoft: the browser comes back from Microsoft (task 3.1)', () => {
  it('swaps the one-time code (with the PKCE verifier and client secret) and stores the renewable sign-in', async () => {
    const w = world()
    const to = await finishSignIn(new URLSearchParams({ code: 'the-code', state: STATE }), w.fetchImpl)
    expect(to).toBe('/integrations?microsoft=connected')
    expect(Object.fromEntries(w.forms[0])).toEqual({ client_id: 'c-1', client_secret: 'shh', grant_type: 'authorization_code', code: 'the-code',
      redirect_uri: 'https://main.example.dev/api/v1/microsoft/callback', code_verifier: 'v'.repeat(64),
      scope: 'https://api.powerplatform.com/.default offline_access openid profile' })
    expect(w.rpcs.map((r) => r.fn)).toEqual(['microsoft_connect_claim', 'microsoft_connect_finish'])
    expect(w.rpcs[1].body).toEqual({ p_state: STATE, p_refresh_token: 'rt-1', p_account: 'arpit@tenant.test', p_name: 'Arpit Khandelwal' })
  })

  it('sends the person back with a plain reason when Microsoft refuses, the link expired, or nothing came back', async () => {
    const refused = await finishSignIn(new URLSearchParams({ error: 'access_denied', error_description: 'AADSTS65004: User declined to consent.\r\nTrace ID: x', state: STATE }), world().fetchImpl)
    expect(decodeURIComponent(refused)).toBe('/integrations?microsoft=error&reason=Microsoft said: AADSTS65004: User declined to consent.')
    expect(decodeURIComponent(await finishSignIn(new URLSearchParams({ code: 'c', state: STATE }), world({ claimFails: true }).fetchImpl)))
      .toContain('This sign-in link has expired or was already used.')
    expect(decodeURIComponent(await finishSignIn(new URLSearchParams({ code: 'c', state: STATE }), world({ tokenStatus: 400 }).fetchImpl)))
      .toBe('/integrations?microsoft=error&reason=Microsoft refused the sign-in: AADSTS70008: The code expired.')
    expect(decodeURIComponent(await finishSignIn(new URLSearchParams({ code: 'c', state: STATE }), world({ noRefresh: true }).fetchImpl)))
      .toContain('did not return a renewable sign-in')
    const w = world()
    expect(await finishSignIn(new URLSearchParams({ state: 'bad' }), w.fetchImpl)).toContain('microsoft=error')
    expect(w.rpcs).toHaveLength(0) // a malformed return never reaches the database
  })

  it('reads the account from the ID token, and trims Microsoft\'s error text', () => {
    expect(accountFromIdToken(idToken({ upn: 'a@b.c', name: 'A B' }))).toEqual({ account: 'a@b.c', name: 'A B' })
    expect(accountFromIdToken('nonsense')).toEqual({ account: '', name: '' })
    expect(microsoftError({ error_description: 'AADSTS50076: MFA needed. Trace ID: 1 Correlation ID: 2' })).toBe('AADSTS50076: MFA needed.')
  })

  it('the return address redirects to the Integrations page, never caching', async () => {
    const { handleCallback } = await import('./api/v1/microsoft/callback')
    const res = await handleCallback(new Request('https://main.example.dev/api/v1/microsoft/callback?error=access_denied&state=x'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^https:\/\/main\.example\.dev\/integrations\?microsoft=error&reason=/)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('Run Microsoft checks (task 3.1)', () => {
  it('renews the sign-in, lists agents, blocks and unblocks the test agent with read-backs, reads Graph, and reports', async () => {
    const w = world()
    const out = await runMicrosoftChecks(TOKEN, w.fetchImpl, { pauseMs: 0 })
    const v = Object.fromEntries(out!.map((r) => [r.id, r.verdict]))
    expect(v).toEqual({ A1: 'YES', A2: 'YES', B1: 'YES', B2: 'PARTLY', C1: 'YES', C2: 'YES', C3: 'YES', C4: 'YES', D1: 'YES', D2: 'NO', D3: 'STARTED' })
    expect(out!.find((r) => r.id === 'D1')!.detail).toBe('2 user(s) read; 1 with a job title, 1 with a department.')
    const report = w.rpcs.find((r) => r.fn === 'microsoft_check_report')!.body
    expect(report).toMatchObject({ p_token: TOKEN, p_ok: true, p_message: '11 checks: 8 yes, 1 no, 2 other', p_refresh_token: 'rt-2' })
    // Answers were saved as they came (one save per answer, the last holding all of them, in order).
    const saves = w.rpcs.filter((r) => r.fn === 'microsoft_check_progress').map((r) => (r.body.p_results as { id: string }[]).map((x) => x.id))
    expect(saves).toHaveLength(11)
    expect(saves.at(-1)).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'C3', 'C4', 'D1', 'D2', 'D3'])
    // The second renewal (for Graph) used the newest sign-in from the first.
    expect(w.forms[1].get('refresh_token')).toBe('rt-1')
  })

  it('a block the platform does not confirm is a NO; a test agent not in the list is not touched', async () => {
    const refused = await runMicrosoftChecks(TOKEN, world({ blockStatus: 403 }).fetchImpl, { pauseMs: 0 })
    expect(refused!.find((r) => r.id === 'C2')).toMatchObject({ verdict: 'NO' })
    const w = world({ agents: [{ name: 'other', properties: { displayName: 'Someone else', environmentId: 'e', botId: 'other' } }] })
    const out = await runMicrosoftChecks(TOKEN, w.fetchImpl, { pauseMs: 0 })
    expect(out!.find((r) => r.id === 'C1')).toMatchObject({ verdict: 'NOT TESTED' })
    expect(w.fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining('SetAsQuarantined'), expect.anything())
  })

  it('wraps up at the time limit and still reports what it found (people checks are not held up by a slow agent list)', async () => {
    const w = world({ slowListMs: 400 })
    const out = await runMicrosoftChecks(TOKEN, w.fetchImpl, { pauseMs: 0, budgetMs: 150 })
    expect(out!.map((r) => r.id)).toEqual(['A1', 'A2', 'D1', 'D2', 'D3'])
    expect(w.rpcs.find((r) => r.fn === 'microsoft_check_report')!.body.p_message).toBe('Stopped at the time limit; 5 checks: 3 yes, 1 no, 1 other')
    expect(out!.every((r) => typeof r.seconds === 'number')).toBe(true)
  })

  it('a test agent left blocked by a run that was cut off is unblocked first, and ends unblocked', async () => {
    const w = world({ startBlocked: true })
    const out = await runMicrosoftChecks(TOKEN, w.fetchImpl, { pauseMs: 0 })
    expect(out!.find((r) => r.id === 'C2')).toMatchObject({ verdict: 'YES' })
    expect(w.isBlocked()).toBe(false)
  })

  it('stops early and says so when the stored sign-in no longer renews', async () => {
    const w = world({ tokenStatus: 400 })
    const out = await runMicrosoftChecks(TOKEN, w.fetchImpl, { pauseMs: 0 })
    expect(out!.map((r) => r.id)).toEqual(['A1', 'A2'])
    expect(out![1]).toMatchObject({ verdict: 'NO', detail: 'Renewal failed: AADSTS70008: The code expired.' })
    expect(w.rpcs.find((r) => r.fn === 'microsoft_check_report')!.body).toMatchObject({ p_ok: false, p_refresh_token: null })
  })

  it('the endpoint accepts only a Microsoft checks token', async () => {
    const { handleRun } = await import('./api/v1/microsoft/run')
    const later: Promise<unknown>[] = []
    const res = await handleRun({ request: new Request('https://x.test/api/v1/microsoft/run', { method: 'POST', body: JSON.stringify({ token: 'pjt_' + 'a'.repeat(64) }) }),
      waitUntil: (p) => { later.push(p) } })
    expect(res.status).toBe(400)
    expect(later).toHaveLength(0)
  })
})

describe('Microsoft switched off (11 Nov 2026)', () => {
  it('both addresses answer 404 and touch nothing while MICROSOFT_ENABLED is false', async () => {
    const { MICROSOFT_ENABLED } = await import('../functions-lib/features')
    expect(MICROSOFT_ENABLED).toBe(false)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { onRequestGet } = await import('./api/v1/microsoft/callback')
    const { onRequestPost } = await import('./api/v1/microsoft/run')
    const back = await onRequestGet({ request: new Request('https://x.test/api/v1/microsoft/callback?code=c&state=mss_' + 'a'.repeat(64)) })
    expect(back.status).toBe(404)
    const later: Promise<unknown>[] = []
    const run = await onRequestPost({ request: new Request('https://x.test/api/v1/microsoft/run', { method: 'POST', body: JSON.stringify({ token: 'mct_' + 'a'.repeat(64) }) }),
      waitUntil: (p) => { later.push(p) } })
    expect(run.status).toBe(404)
    expect(later).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
