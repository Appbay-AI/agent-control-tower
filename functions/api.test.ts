// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost as register } from './api/v1/agents/register'
import { onRequestGet as status } from './api/v1/agents/[id]/status'

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
