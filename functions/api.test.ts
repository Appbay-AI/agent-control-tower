// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost as register } from './api/v1/agents/register'
import { onRequestGet as status } from './api/v1/agents/[id]/status'
import { onRequestPost as requestAction } from './api/v1/actions/request'
import { onRequestGet as actionStatus } from './api/v1/actions/[id]'
import { onRequestPost as heartbeat } from './api/v1/agents/[id]/heartbeat'
import { onRequestPost as logs } from './api/v1/agents/[id]/logs'
import { onRequestPost as reportIncident } from './api/v1/incidents'

const db = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

const req = (url: string, init: RequestInit = {}) => new Request(`https://act.test${url}`, init)

afterEach(() => vi.unstubAllGlobals())

describe('POST /api/v1/agents/register', () => {
  it('needs an integration key', async () => {
    const res = await register({ request: req('/api/v1/agents/register', { method: 'POST', body: '{}' }), params: {} })
    expect(res.status).toBe(401)
  })

  it('rejects a body that is not a JSON object', async () => {
    const res = await register({ request: req('/x', { method: 'POST', body: 'nope', headers: { authorization: 'Bearer k' } }), params: {} })
    expect(res.status).toBe(400)
  })

  it('passes the key and payload to the database and returns 201 with the agent key', async () => {
    const fetchMock = db(200, { agent_code: 'AGT-0042', status: 'proposed', api_key: 'act_agt_x' })
    vi.stubGlobal('fetch', fetchMock)
    const res = await register({
      request: req('/x', { method: 'POST', body: JSON.stringify({ name: 'Bot' }), headers: { authorization: 'Bearer act_int_abc' } }),
      params: {},
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ agent_code: 'AGT-0042', api_key: 'act_agt_x' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/rest\/v1\/rpc\/api_register_agent$/)
    expect(JSON.parse(String(init.body))).toEqual({ p_integration_key: 'act_int_abc', p_payload: { name: 'Bot' } })
  })

  it('turns database errors into clear HTTP answers', async () => {
    const call = async (code: string) => {
      vi.stubGlobal('fetch', db(400, { code, message: 'from the database' }))
      return register({ request: req('/x', { method: 'POST', body: '{}', headers: { authorization: 'Bearer k' } }), params: {} })
    }
    expect((await call('28000')).status).toBe(401)
    expect((await call('23514')).status).toBe(422)
    const other = await call('XX000')
    expect(other.status).toBe(502)
    expect(await other.json()).toEqual({ error: 'upstream_error', message: 'from the database' })
  })

  it('answers 503 when the database is unreachable, so agents fail closed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network') }))
    const res = await register({ request: req('/x', { method: 'POST', body: '{}', headers: { authorization: 'Bearer k' } }), params: {} })
    expect(res.status).toBe(503)
  })
})

describe('GET /api/v1/agents/{id}/status', () => {
  const live = { agent_id: 'uuid-1', agent_code: 'AGT-0001', status: 'live', may_act: true, autonomy_level: 3 }

  it('returns the status when the key belongs to that agent, by id or code', async () => {
    vi.stubGlobal('fetch', db(200, live))
    for (const id of ['uuid-1', 'agt-0001']) {
      const res = await status({ request: req(`/api/v1/agents/${id}/status`, { headers: { authorization: 'Bearer act_agt_k' } }), params: { id } })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ may_act: true })
    }
  })

  it("refuses another agent's key", async () => {
    vi.stubGlobal('fetch', db(200, live))
    const res = await status({ request: req('/x', { headers: { authorization: 'Bearer act_agt_k' } }), params: { id: 'AGT-0002' } })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/v1/actions/request', () => {
  const post = (body: unknown, headers: Record<string, string> = { authorization: 'Bearer act_agt_k' }) =>
    requestAction({ request: req('/api/v1/actions/request', { method: 'POST', body: JSON.stringify(body), headers }), params: {} })

  it('needs an agent key', async () => {
    expect((await post({}, {})).status).toBe(401)
  })

  it('answers 201 for a new request and 200 for a retry', async () => {
    vi.stubGlobal('fetch', db(200, { status: 'approved', may_proceed: true, duplicate: false }))
    expect((await post({ idempotency_key: 'a', action: 'x' })).status).toBe(201)
    vi.stubGlobal('fetch', db(200, { status: 'approved', may_proceed: true, duplicate: true }))
    expect((await post({ idempotency_key: 'a', action: 'x' })).status).toBe(200)
  })

  it('takes the idempotency key from the Idempotency-Key header', async () => {
    const fetchMock = db(200, { status: 'pending', duplicate: false })
    vi.stubGlobal('fetch', fetchMock)
    await post({ action: 'x' }, { authorization: 'Bearer act_agt_k', 'idempotency-key': 'hdr-1' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ p_agent_key: 'act_agt_k', p_payload: { action: 'x', idempotency_key: 'hdr-1' } })
  })

  it('refuses a header and body key that disagree', async () => {
    const res = await post({ idempotency_key: 'a' }, { authorization: 'Bearer act_agt_k', 'idempotency-key': 'b' })
    expect(res.status).toBe(422)
  })

  it('maps a reused key to 409 Conflict', async () => {
    vi.stubGlobal('fetch', db(400, { code: '23505', message: 'idempotency_key a was already used for a different request' }))
    expect((await post({ idempotency_key: 'a', action: 'x' })).status).toBe(409)
  })
})

describe('GET /api/v1/actions/{id}', () => {
  it('passes the request code to the database', async () => {
    const fetchMock = db(200, { request_code: 'REQ-000001', status: 'pending', may_proceed: false })
    vi.stubGlobal('fetch', fetchMock)
    const res = await actionStatus({ request: req('/x', { headers: { authorization: 'Bearer act_agt_k' } }), params: { id: 'REQ-000001' } })
    expect(res.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ p_agent_key: 'act_agt_k', p_request: 'REQ-000001' })
  })

  it('answers 404 for a request that is not this agent\'s', async () => {
    vi.stubGlobal('fetch', db(400, { code: 'P0002', message: 'No request REQ-9 for this agent' }))
    const res = await actionStatus({ request: req('/x', { headers: { authorization: 'Bearer k' } }), params: { id: 'REQ-9' } })
    expect(res.status).toBe(404)
  })
})

// Task 2.11
describe('POST /api/v1/agents/{id}/heartbeat', () => {
  const auth = { authorization: 'Bearer act_agt_k' }
  const sent = (m: ReturnType<typeof db>) => JSON.parse(String((m.mock.calls[0] as unknown as [string, RequestInit])[1].body))

  it('checks in with or without a note, naming the agent from the path', async () => {
    const answer = { agent_code: 'AGT-0001', status: 'live', may_act: true, heard_at: 'now', silent_after_minutes: 15, check_in_by: 'later' }
    let m = db(200, answer)
    vi.stubGlobal('fetch', m)
    const res = await heartbeat({ request: req('/x', { method: 'POST', headers: auth }), params: { id: 'AGT-0001' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(answer)
    expect(sent(m)).toEqual({ p_agent_key: 'act_agt_k', p_agent: 'AGT-0001', p_note: null })
    m = db(200, answer)
    vi.stubGlobal('fetch', m)
    await heartbeat({ request: req('/x', { method: 'POST', headers: auth, body: JSON.stringify({ note: 'Queue: 12' }) }), params: { id: 'AGT-0001' } })
    expect(sent(m).p_note).toBe('Queue: 12')
  })

  it('refuses a missing key, bad JSON and a note that is not text; maps a different agent to 403', async () => {
    expect((await heartbeat({ request: req('/x', { method: 'POST' }), params: { id: 'a' } })).status).toBe(401)
    expect((await heartbeat({ request: req('/x', { method: 'POST', headers: auth, body: '{' }), params: { id: 'a' } })).status).toBe(400)
    expect((await heartbeat({ request: req('/x', { method: 'POST', headers: auth, body: '{"note": 5}' }), params: { id: 'a' } })).status).toBe(422)
    vi.stubGlobal('fetch', db(400, { code: '42501', message: 'This key belongs to a different agent.' }))
    expect((await heartbeat({ request: req('/x', { method: 'POST', headers: auth }), params: { id: 'AGT-0002' } })).status).toBe(403)
  })
})

describe('POST /api/v1/agents/{id}/logs', () => {
  const auth = { authorization: 'Bearer act_agt_k', 'content-type': 'application/json' }
  const post = (body: string) => logs({ request: req('/x', { method: 'POST', headers: auth, body }), params: { id: 'AGT-0001' } })
  const sent = (m: ReturnType<typeof db>) => JSON.parse(String((m.mock.calls[0] as unknown as [string, RequestInit])[1].body))

  it('accepts one entry, a list, or { entries }, and answers 201', async () => {
    for (const [body, entries] of [
      [{ message: 'one' }, { message: 'one' }],
      [[{ message: 'a' }, { message: 'b' }], [{ message: 'a' }, { message: 'b' }]],
      [{ entries: [{ message: 'c' }] }, [{ message: 'c' }]],
    ] as const) {
      const m = db(200, { accepted: 1, duplicates: 0, may_act: true })
      vi.stubGlobal('fetch', m)
      const res = await post(JSON.stringify(body))
      expect(res.status).toBe(201)
      expect(sent(m)).toEqual({ p_agent_key: 'act_agt_k', p_agent: 'AGT-0001', p_entries: entries })
    }
  })

  it('refuses bad JSON, too much at once, and passes on the database\'s reason for a bad entry', async () => {
    expect((await post('not json')).status).toBe(400)
    expect((await post('"text"')).status).toBe(400)
    expect((await post('{"entries": 3}')).status).toBe(422)
    const big = await logs({ request: req('/x', { method: 'POST', headers: { ...auth, 'content-length': '2000000' }, body: '{}' }), params: { id: 'a' } })
    expect(big.status).toBe(413)
    vi.stubGlobal('fetch', db(400, { code: '23514', message: 'Entry 2: message is required' }))
    const res = await post('[{"message": "a"}, {}]')
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'invalid_request', message: 'Entry 2: message is required' })
  })
})

describe('POST /api/v1/incidents (task 4.4)', () => {
  const post = (body: unknown, headers: Record<string, string> = { authorization: 'Bearer act_int_k' }) =>
    reportIncident({ request: req('/api/v1/incidents', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers }), params: {} })

  it('needs a key and a JSON object', async () => {
    expect((await post({ title: 'x' }, {})).status).toBe(401)
    expect((await post('nope')).status).toBe(400)
    expect((await post([1])).status).toBe(400)
  })

  it('passes either kind of key, the body and the idempotency header to the database', async () => {
    const fetchMock = db(200, { incident_code: 'INC-0001', owner: 'James Whitfield', duplicate: false })
    vi.stubGlobal('fetch', fetchMock)
    const res = await post({ agent: 'AGT-0001', title: 'Paid twice' }, { authorization: 'Bearer act_int_k', 'idempotency-key': 'evt-1' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ incident_code: 'INC-0001', owner: 'James Whitfield' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/rest\/v1\/rpc\/api_report_incident$/)
    expect(JSON.parse(String(init.body))).toEqual({ p_key: 'act_int_k', p_payload: { agent: 'AGT-0001', title: 'Paid twice', idempotency_key: 'evt-1' } })
  })

  it('answers 200 for a retry, 422 for bad input and for header and body keys that differ', async () => {
    vi.stubGlobal('fetch', db(200, { incident_code: 'INC-0001', duplicate: true }))
    expect((await post({ title: 'x', idempotency_key: 'a' })).status).toBe(200)
    expect((await post({ title: 'x', idempotency_key: 'a' }, { authorization: 'Bearer k', 'idempotency-key': 'b' })).status).toBe(422)
    vi.stubGlobal('fetch', db(400, { code: '23514', message: 'title is required' }))
    const bad = await post({})
    expect(bad.status).toBe(422)
    expect(await bad.json()).toEqual({ error: 'invalid_request', message: 'title is required' })
    vi.stubGlobal('fetch', db(400, { code: 'P0002', message: 'No agent AGT-9999' }))
    expect((await post({ agent: 'AGT-9999', title: 'x' })).status).toBe(404)
  })
})
