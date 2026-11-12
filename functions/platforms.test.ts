// @vitest-environment node
// Task 3.2: the tests every agent-platform plug-in must pass (the "contract"), run against:
//   1. a reference platform kept in memory, to show the tests ask nothing platform-specific;
//   2. the Appian plug-in, talking to a stand-in Appian server built from appian/SIMULATOR_SPEC.md;
//   3. the Appian plug-in, talking to the real simulator. Only when APPIAN_BASE and APPIAN_API_KEY are set
//      (the "Appian simulator check" workflow); it blocks NAP-001 briefly and puts it back as it was.
// Microsoft's plug-in must pass the same contract before it is used.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAppianPlugin, parseAgent } from '../functions-lib/platforms/appian'
import {
  PlatformError, pluginFor, type PlatformAgentState, type PlatformAgentStatus, type PlatformErrorCode, type PlatformPlugin,
} from '../functions-lib/platforms'

const CHANGE = { reason: 'Contract test from Agent Control Tower', requestedBy: 'act-integration' }

async function failsWith(p: Promise<unknown>, code: PlatformErrorCode): Promise<PlatformError> {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e, `expected a PlatformError "${code}"`).toBeInstanceOf(PlatformError)
  expect((e as PlatformError).code).toBe(code)
  return e as PlatformError
}

interface Target {
  plugin: PlatformPlugin
  /** An agent the tests may block and unblock. */
  agent: string
  /** An id the platform does not have. */
  unknown: string
  /** The same platform with wrong credentials. */
  wrongCredentials: PlatformPlugin
}

/** The contract. Leaves the test agent as it found it. */
function platformContract(name: string, setup: () => Promise<Target>) {
  describe(`platform contract: ${name}`, () => {
    let t: Target
    let startedAs: PlatformAgentStatus
    beforeAll(async () => {
      t = await setup()
      startedAs = (await t.plugin.readStatus(t.agent)).status
    })
    afterAll(async () => {
      if (!t) return
      if (startedAs === 'active') await t.plugin.unblock(t.agent, { ...CHANGE, reason: 'Contract test finished: restoring' })
      else await t.plugin.block(t.agent, { ...CHANGE, reason: 'Contract test finished: restoring' })
    })

    it('lists agents, each with an id, a name, a status and lists that are lists', async () => {
      const agents = await t.plugin.listAgents()
      expect(agents.length).toBeGreaterThan(0)
      expect(new Set(agents.map((a) => a.externalId)).size).toBe(agents.length)
      for (const a of agents) {
        expect(a.externalId).toEqual(expect.any(String))
        expect(a.name).toEqual(expect.any(String))
        expect(['active', 'blocked']).toContain(a.status)
        for (const list of [a.dataSources, a.tools, a.dataClassifications, a.sharedWith]) expect(Array.isArray(list)).toBe(true)
        expect(a.owner === null || typeof a.owner.email === 'string').toBe(true)
      }
      expect(agents.map((a) => a.externalId)).toContain(t.agent)
      expect(agents.map((a) => a.externalId)).not.toContain(t.unknown)
    })

    it('reads one agent, and says when there is no such agent', async () => {
      const listed = (await t.plugin.listAgents()).find((a) => a.externalId === t.agent)!
      const state = await t.plugin.readStatus(t.agent)
      expect(state).toMatchObject({ externalId: t.agent, status: listed.status })
      await failsWith(t.plugin.readStatus(t.unknown), 'not_found')
    })

    it('blocks an agent, reads it back as blocked, and blocking again is safe', async () => {
      const set: PlatformAgentState = await t.plugin.block(t.agent, CHANGE)
      expect(set).toMatchObject({ externalId: t.agent, status: 'blocked' })
      expect(await t.plugin.readStatus(t.agent)).toMatchObject({ status: 'blocked' })
      expect(await t.plugin.block(t.agent, CHANGE)).toMatchObject({ status: 'blocked' })
      expect((await t.plugin.listAgents()).find((a) => a.externalId === t.agent)?.status).toBe('blocked')
    })

    it('unblocks it and reads it back as active, and unblocking again is safe', async () => {
      expect(await t.plugin.unblock(t.agent, CHANGE)).toMatchObject({ externalId: t.agent, status: 'active' })
      expect(await t.plugin.readStatus(t.agent)).toMatchObject({ status: 'active' })
      expect(await t.plugin.unblock(t.agent, CHANGE)).toMatchObject({ status: 'active' })
    })

    it('says when asked to block an agent it does not have', async () => {
      await failsWith(t.plugin.block(t.unknown, CHANGE), 'not_found')
    })

    it('refuses to change status without a reason', async () => {
      await failsWith(t.plugin.block(t.agent, { reason: ' ', requestedBy: 'act-integration' }), 'refused')
    })

    it('says when the credentials are wrong', async () => {
      await failsWith(t.wrongCredentials.listAgents(), 'unauthorized')
      await failsWith(t.wrongCredentials.block(t.agent, CHANGE), 'unauthorized')
    })
  })
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Reference platform, in memory
// ---------------------------------------------------------------------------------------------------------------
function memoryPlatform(credentialsOk = true, states = new Map<string, PlatformAgentState>()): PlatformPlugin {
  if (states.size === 0) for (const id of ['M-1', 'M-2']) states.set(id, { externalId: id, status: 'active', changedAt: null, changedBy: null })
  const guard = () => { if (!credentialsOk) throw new PlatformError('unauthorized', 'wrong credentials') }
  const get = (id: string) => {
    guard()
    const s = states.get(id)
    if (!s) throw new PlatformError('not_found', `no agent ${id}`)
    return s
  }
  const set = async (id: string, status: PlatformAgentStatus, change: { reason: string; requestedBy: string }) => {
    get(id)
    if (!change.reason.trim()) throw new PlatformError('refused', 'reason required')
    const s = { externalId: id, status, changedAt: new Date().toISOString(), changedBy: change.requestedBy }
    states.set(id, s)
    return { ...s }
  }
  return {
    kind: 'appian_simulator', label: 'In memory',
    async listAgents() {
      guard()
      return [...states.values()].map((s) => ({
        externalId: s.externalId, name: `Agent ${s.externalId}`, description: null, environment: null, status: s.status,
        statusChangedAt: s.changedAt, statusChangedBy: s.changedBy, owner: null, department: null, dataSources: [], tools: [],
        dataClassifications: [], sharedWith: [], sessions30d: null, lastActiveAt: null, createdAt: null, createdBy: null,
      }))
    },
    readStatus: async (id) => ({ ...get(id) }),
    block: (id, c) => set(id, 'blocked', c),
    unblock: (id, c) => set(id, 'active', c),
  }
}

platformContract('reference (in memory)', async () => {
  const states = new Map<string, PlatformAgentState>()
  return { plugin: memoryPlatform(true, states), agent: 'M-1', unknown: 'M-999', wrongCredentials: memoryPlatform(false, states) }
})

// ---------------------------------------------------------------------------------------------------------------
// 2. Appian plug-in against a stand-in Appian server (appian/SIMULATOR_SPEC.md, "Web APIs")
// ---------------------------------------------------------------------------------------------------------------
const SITE = 'https://appbay-demo.appiancloud.com'
const KEY = 'test-appian-key'

function napAgent(id: string, status = 'active') {
  return {
    externalId: id, name: `Agent ${id}`, description: 'Issues customer refunds under £500', environment: 'Production', status,
    statusChangedAt: '2026-10-20T08:00:00Z', statusChangedBy: 'appian.admin',
    owner: id === 'NAP-004' ? null : { email: 'lucy.grant@northbridge.demo', name: 'Lucy Grant' },
    department: 'Customer Service', dataSources: ['Core banking', 'CRM'], tools: ['Payments API'],
    dataClassifications: ['personal', 'confidential'],
    sharedWith: [{ email: 'ana.costa@northbridge.demo', name: 'Ana Costa', jobTitle: 'Sales Associate', department: 'Retail Lending' }],
    sessions30d: 412, lastActiveAt: '2026-10-28T17:42:00Z', createdAt: '2026-09-01T10:00:00Z', createdBy: 'appian.admin',
  }
}

/** A stand-in for the simulator's three web APIs. `history` records each real status change, as the spec requires. */
function fakeAppian() {
  const agents = new Map(['NAP-001', 'NAP-004', 'NAP-007'].map((id) => [id, napAgent(id, id === 'NAP-007' ? 'quarantined' : 'active')]))
  const history: { externalId: string; from: string; to: string; by: string; reason: string }[] = []
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const stateOf = (a: ReturnType<typeof napAgent>) =>
    ({ externalId: a.externalId, status: a.status, statusChangedAt: a.statusChangedAt, statusChangedBy: a.statusChangedBy })
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    if (headers.get('Appian-API-Key') !== KEY) return reply(401, { error: 'Not authorized' })
    const alias = url.pathname.replace('/suite/webapi/', '')
    if (alias === 'nap-agents' && (init?.method ?? 'GET') === 'GET') return reply(200, { agents: [...agents.values()] })
    if (alias === 'nap-agent-status' && (init?.method ?? 'GET') === 'GET') {
      const a = agents.get(url.searchParams.get('externalId') ?? '')
      return a ? reply(200, stateOf(a)) : reply(404, { error: 'No such agent' })
    }
    if (alias === 'nap-agent-status-set' && init?.method === 'POST') {
      const b = JSON.parse(String(init.body)) as { externalId?: string; status?: string; reason?: string; requestedBy?: string }
      if (!b.externalId || !b.reason || !b.requestedBy || !['active', 'quarantined'].includes(b.status ?? '')) {
        return reply(400, { error: 'status must be active or quarantined' })
      }
      const a = agents.get(b.externalId)
      if (!a) return reply(404, { error: 'No such agent' })
      if (a.status !== b.status) {
        history.push({ externalId: a.externalId, from: a.status, to: b.status!, by: b.requestedBy, reason: b.reason })
        Object.assign(a, { status: b.status, statusChangedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), statusChangedBy: b.requestedBy })
      }
      return reply(200, stateOf(a))
    }
    return reply(404, { error: 'No such web API' })
  })
  return { agents, history, fetch: handler as unknown as typeof fetch, handler }
}

describe('Appian plug-in against a stand-in simulator', () => {
  const server = fakeAppian()
  platformContract('Appian simulator (stand-in)', async () => ({
    plugin: pluginFor({ id: 'c1', kind: 'appian_simulator', base_url: SITE, secret: KEY }, server.fetch),
    agent: 'NAP-001', unknown: 'NAP-999',
    wrongCredentials: pluginFor({ id: 'c1', kind: 'appian_simulator', base_url: SITE, secret: 'wrong' }, server.fetch),
  }))

  it('calls the documented addresses with the API key, and records why and who in the platform', async () => {
    const s = fakeAppian()
    const p = createAppianPlugin({ baseUrl: `${SITE}/`, apiKey: KEY }, s.fetch)
    await p.block('NAP-001', { reason: 'Suspended in Agent Control Tower: incident INC-0007', requestedBy: 'act-integration' })
    const [url, init] = s.handler.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${SITE}/suite/webapi/nap-agent-status-set`)
    expect(new Headers(init.headers).get('Appian-API-Key')).toBe(KEY)
    expect(JSON.parse(String(init.body))).toEqual({ externalId: 'NAP-001', status: 'quarantined',
      reason: 'Suspended in Agent Control Tower: incident INC-0007', requestedBy: 'act-integration' })
    expect(s.history).toEqual([{ externalId: 'NAP-001', from: 'active', to: 'quarantined', by: 'act-integration',
      reason: 'Suspended in Agent Control Tower: incident INC-0007' }])
    await p.block('NAP-001', CHANGE) // already blocked: no new history row
    expect(s.history).toHaveLength(1)
    expect(await p.readStatus('NAP-007')).toMatchObject({ status: 'blocked' }) // "quarantined" in Appian's words
  })

  it('turns the agent list into Control Tower words, keeping ownerless agents and who it is shared with', async () => {
    const agents = await createAppianPlugin({ baseUrl: SITE, apiKey: KEY }, fakeAppian().fetch).listAgents()
    expect(agents.find((a) => a.externalId === 'NAP-004')?.owner).toBeNull()
    expect(agents.find((a) => a.externalId === 'NAP-007')?.status).toBe('blocked')
    expect(agents.find((a) => a.externalId === 'NAP-001')).toMatchObject({
      owner: { email: 'lucy.grant@northbridge.demo', name: 'Lucy Grant' }, sessions30d: 412,
      sharedWith: [{ email: 'ana.costa@northbridge.demo', jobTitle: 'Sales Associate', department: 'Retail Lending' }],
    })
  })

  it('never guesses: an answer that breaks the contract is an error', async () => {
    const answering = (status: number, body: unknown) => createAppianPlugin({ baseUrl: SITE, apiKey: KEY },
      (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch)
    await failsWith(answering(200, '<html>Sign in</html>').listAgents(), 'bad_response')
    await failsWith(answering(200, { agents: null }).listAgents(), 'bad_response')
    await failsWith(answering(200, { agents: [napAgent('NAP-001', 'paused')] }).listAgents(), 'bad_response')
    await failsWith(answering(200, { agents: [napAgent('NAP-001'), napAgent('NAP-001')] }).listAgents(), 'bad_response')
    await failsWith(answering(200, { agents: [{ ...napAgent('NAP-001'), tools: 'Payments API' }] }).listAgents(), 'bad_response')
    // Asked to block, but the answer says active, or is about another agent: not believed.
    await failsWith(answering(200, { externalId: 'NAP-001', status: 'active' }).block('NAP-001', CHANGE), 'bad_response')
    await failsWith(answering(200, { externalId: 'NAP-002', status: 'quarantined' }).block('NAP-001', CHANGE), 'bad_response')
    expect(() => parseAgent({ externalId: 'NAP-1', name: 'x', status: 'active', statusChangedAt: 'yesterday' }, 0)).toThrow(/not a date/)
  })

  it('sorts failures into what the caller should do', async () => {
    const answering = (status: number, body: unknown = { error: 'Something' }) => createAppianPlugin({ baseUrl: SITE, apiKey: KEY },
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch)
    await failsWith(answering(403).listAgents(), 'unauthorized')
    await failsWith(answering(302).listAgents(), 'unauthorized') // Appian's redirect to its sign-in page
    const refused = await failsWith(answering(400, { error: 'status must be active or quarantined' }).block('NAP-001', CHANGE), 'refused')
    expect(refused.message).toContain('status must be active or quarantined')
    await failsWith(answering(500).listAgents(), 'unreachable')
    await failsWith(answering(503).readStatus('NAP-001'), 'unreachable')
    const down = createAppianPlugin({ baseUrl: SITE, apiKey: KEY }, (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch)
    await failsWith(down.listAgents(), 'unreachable')
    const slow = createAppianPlugin({ baseUrl: SITE, apiKey: KEY, timeoutMs: 20 }, ((_: unknown, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch)
    expect((await failsWith(slow.listAgents(), 'unreachable')).message).toContain('did not answer')
  })

  it('refuses unsafe site addresses, a missing key and unknown platform kinds', () => {
    expect(() => createAppianPlugin({ baseUrl: 'http://appbay-demo.appiancloud.com', apiKey: KEY })).toThrow(/https/)
    expect(() => createAppianPlugin({ baseUrl: 'https://10.0.0.1', apiKey: KEY })).toThrow(PlatformError)
    expect(() => createAppianPlugin({ baseUrl: SITE, apiKey: '' })).toThrow(/No Appian API key/)
    expect(() => pluginFor({ id: 'c', kind: 'microsoft_copilot_studio', base_url: SITE, secret: 'x' })).toThrow(/No plug-in/)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// 3. The real simulator (Appian simulator check workflow only)
// ---------------------------------------------------------------------------------------------------------------
const LIVE_BASE = process.env.APPIAN_BASE ?? ''
const LIVE_KEY = process.env.APPIAN_API_KEY ?? ''
describe.runIf(LIVE_BASE && LIVE_KEY)('Appian plug-in against the real simulator', () => {
  platformContract(`Appian simulator at ${LIVE_BASE}`, async () => ({
    plugin: pluginFor({ id: 'live', kind: 'appian_simulator', base_url: LIVE_BASE, secret: LIVE_KEY }),
    agent: 'NAP-001', unknown: 'NAP-999',
    wrongCredentials: pluginFor({ id: 'live', kind: 'appian_simulator', base_url: LIVE_BASE, secret: 'not-a-real-key' }),
  }))
})

// ---------------------------------------------------------------------------------------------------------------
// Running a job handed over by the database ("Test connection")
// ---------------------------------------------------------------------------------------------------------------
describe('platform jobs run by our API', () => {
  const TOKEN = 'pjt_' + 'a'.repeat(64)
  /** Supabase (claim and report) and the stand-in Appian simulator, behind one fetch. */
  function world(secret: string, kind = 'check', applyAnswer: Response | null = null) {
    const appian = fakeAppian()
    const reports: Record<string, unknown>[] = []
    const applied: { p_token: string; p_agents: { externalId: string; status: string }[] }[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/rpc/platform_job_claim')) {
        return new Response(JSON.stringify({ job: 7, kind,
          connection: { id: 'c1', kind: 'appian_simulator', name: 'Northbridge Agent Platform (simulated)', base_url: SITE, secret } }), { status: 200 })
      }
      if (url.endsWith('/rpc/platform_job_report')) { reports.push(JSON.parse(String(init?.body))); return new Response('null', { status: 200 }) }
      if (url.endsWith('/rpc/platform_sync_apply')) {
        applied.push(JSON.parse(String(init?.body)))
        return applyAnswer ?? new Response(JSON.stringify({ agents: 3, new: 1, status_changed: 0, back: 0, missing: 1, blocked: 1 }), { status: 200 })
      }
      return appian.fetch(input, init)
    }) as unknown as typeof fetch
    return { fetchImpl, reports, applied }
  }

  it('checks the connection and reports how many agents it found', async () => {
    const { runPlatformJob } = await import('../functions-lib/platforms/run')
    const w = world(KEY)
    const out = await runPlatformJob(TOKEN, w.fetchImpl)
    expect(out).toMatchObject({ ok: true,
      message: 'Connected to Northbridge Agent Platform (simulated): 3 agents found (1 blocked, 1 without an owner)' })
    expect(w.reports).toEqual([{ p_token: TOKEN, p_ok: true, p_message: out!.message,
      p_result: { agents: 3, blocked: 1, ownerless: 1, names: ['NAP-001 Agent NAP-001', 'NAP-004 Agent NAP-004', 'NAP-007 Agent NAP-007'] } }])
  })

  it('reports a refused key plainly, without the key', async () => {
    const { runPlatformJob } = await import('../functions-lib/platforms/run')
    const w = world('wrong-key')
    const out = await runPlatformJob(TOKEN, w.fetchImpl)
    expect(out).toEqual({ ok: false, message: 'The Appian simulator refused the API key (HTTP 401).', result: { error: 'unauthorized', http_status: 401 } })
    expect(JSON.stringify(w.reports)).not.toContain('wrong-key')
  })

  it('a sync hands every agent to the database, in Control Tower words, and reports what changed', async () => {
    const { runPlatformJob } = await import('../functions-lib/platforms/run')
    const w = world(KEY, 'sync')
    const out = await runPlatformJob(TOKEN, w.fetchImpl)
    expect(w.applied).toHaveLength(1)
    expect(w.applied[0].p_token).toBe(TOKEN)
    expect(w.applied[0].p_agents.map((a) => [a.externalId, a.status])).toEqual([['NAP-001', 'active'], ['NAP-004', 'active'], ['NAP-007', 'blocked']])
    expect(out).toEqual({ ok: true, message: 'Synced 3 agents from Northbridge Agent Platform (simulated): 1 new, 1 missing at source',
      result: { agents: 3, new: 1, status_changed: 0, back: 0, missing: 1, blocked: 1 } })
    expect(w.reports[0]).toMatchObject({ p_ok: true, p_message: out!.message })
  })

  it('a sync that the platform or the database refuses is reported as failed, and nothing is half-stored', async () => {
    const { runPlatformJob } = await import('../functions-lib/platforms/run')
    const refused = world('wrong-key', 'sync')
    expect(await runPlatformJob(TOKEN, refused.fetchImpl)).toMatchObject({ ok: false, result: { error: 'unauthorized' } })
    expect(refused.applied).toHaveLength(0) // a failed list never marks agents missing
    const dbSaysNo = world(KEY, 'sync', new Response(JSON.stringify({ code: '23514', message: 'Agent NAP-001 is listed twice' }), { status: 400 }))
    expect(await runPlatformJob(TOKEN, dbSaysNo.fetchImpl)).toEqual({ ok: false,
      message: 'The agent list could not be stored: Agent NAP-001 is listed twice', result: { error: 'store_failed' } })
    expect(dbSaysNo.reports[0]).toMatchObject({ p_ok: false })
  })

  it('does nothing when the token is refused', async () => {
    const { runPlatformJob } = await import('../functions-lib/platforms/run')
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: '28000', message: 'Invalid or used job token' }), { status: 401 }))
    expect(await runPlatformJob(TOKEN, fetchImpl as unknown as typeof fetch)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('the endpoint only accepts a job token, and answers at once', async () => {
    const { onRequestPost } = await import('./api/v1/platforms/run')
    const later: Promise<unknown>[] = []
    const post = (body: unknown) => onRequestPost({ request: new Request('https://x.test/api/v1/platforms/run', { method: 'POST', body: JSON.stringify(body) }),
      waitUntil: (p) => { later.push(p) } })
    expect((await post({ token: 'pdt_' + 'a'.repeat(64) })).status).toBe(400)
    expect(later).toHaveLength(0)
  })
})

describe('reconciliation check run by our API (task 4.7)', () => {
  const TOKEN = 'pjt_' + 'b'.repeat(64)
  function world(targets: { platform_agent_id: string; external_id: string; agent_code: string }[], applyAnswer: object) {
    const appian = fakeAppian()
    const reports: Record<string, unknown>[] = []
    const applied: { p_token: string; p_results: { platform_agent_id: string; status: string }[] }[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/rpc/platform_job_claim')) {
        return new Response(JSON.stringify({ job: 9, kind: 'reconcile', targets,
          connection: { id: 'c1', kind: 'appian_simulator', name: 'Northbridge Agent Platform (simulated)', base_url: SITE, secret: KEY } }), { status: 200 })
      }
      if (url.endsWith('/rpc/platform_job_report')) { reports.push(JSON.parse(String(init?.body))); return new Response('null', { status: 200 }) }
      if (url.endsWith('/rpc/platform_reconcile_apply')) { applied.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify(applyAnswer), { status: 200 }) }
      return appian.fetch(input, init)
    }) as unknown as typeof fetch
    return { fetchImpl, reports, applied }
  }

  it('reads each suspended agent on the platform and hands the statuses to the database', async () => {
    const { runPlatformJob } = await import('../functions-lib/platforms/run')
    const w = world([{ platform_agent_id: 'p1', external_id: 'NAP-001', agent_code: 'AGT-0122' },
      { platform_agent_id: 'p7', external_id: 'NAP-007', agent_code: 'AGT-0047' }, { platform_agent_id: 'p9', external_id: 'NAP-999', agent_code: 'AGT-0099' }],
      { checked: 3, reblocked: 1, agents: ['AGT-0122'] })
    const out = await runPlatformJob(TOKEN, w.fetchImpl)
    // changed_by: Appian's own record of who last changed the status (task 4.9 drift records); the simulator may leave it empty.
    expect(w.applied[0].p_results).toEqual([{ platform_agent_id: 'p1', status: 'active', changed_by: expect.toBeOneOf([expect.any(String), null]) },
      { platform_agent_id: 'p7', status: 'blocked', changed_by: expect.toBeOneOf([expect.any(String), null]) },
      { platform_agent_id: 'p9', status: 'missing', error: expect.any(String) }])
    expect(out).toEqual({ ok: true, result: { checked: 3, reblocked: 1, agents: ['AGT-0122'], unreadable: 0 },
      message: 'Checked 3 suspended agents on Northbridge Agent Platform (simulated); AGT-0122 switched back on outside Control Tower: blocking again, Critical incident opened' })
    expect(w.reports[0]).toMatchObject({ p_token: TOKEN, p_ok: true })
  })

  it('all still blocked; an agent it cannot read is left for the next cycle and the job says so', async () => {
    const { runPlatformJob } = await import('../functions-lib/platforms/run')
    const quiet = world([{ platform_agent_id: 'p7', external_id: 'NAP-007', agent_code: 'AGT-0047' }], { checked: 1, reblocked: 0, agents: [] })
    expect((await runPlatformJob(TOKEN, quiet.fetchImpl))!.message).toBe('Checked 1 suspended agent on Northbridge Agent Platform (simulated); all still blocked')
    const w = world([{ platform_agent_id: 'p1', external_id: 'NAP-001', agent_code: 'AGT-0122' }], { checked: 1, reblocked: 0, agents: [] })
    const down = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('nap-agent-status') ? new Response('busy', { status: 503 }) : w.fetchImpl(input, init)) as unknown as typeof fetch
    const out = await runPlatformJob(TOKEN, down)
    expect(w.applied[0].p_results[0]).toMatchObject({ platform_agent_id: 'p1', status: 'unreadable' })
    expect(out).toMatchObject({ ok: false, message: expect.stringMatching(/; 1 could not be read \(/) })
  })
})
