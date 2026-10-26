// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { callbackUrlProblem, deliverCallback, type SignedCallback } from '../functions-lib/callback'
import { dispatch } from './api/v1/push/dispatch'
import { onRequestPost as demoReceive } from './api/v1/demo-agent/callback'

const cb: SignedCallback = {
  id: 9, url: 'https://agent.example.com/act/decisions', request_id: 'r-9',
  body: '{"event": "action.decided", "status": "approved", "may_proceed": true}',
  signature: 't=1761480000,v1=' + 'a'.repeat(64),
}

describe('decision callbacks (task 2.8)', () => {
  it('only calls public https host names', () => {
    expect(callbackUrlProblem('https://agent.example.com/x')).toBeNull()
    expect(callbackUrlProblem('http://agent.example.com/x')).toBe('must use https')
    expect(callbackUrlProblem('https://localhost/x')).toBe('not a public address')
    expect(callbackUrlProblem('https://payments-server/x')).toBe('not a public address')
    expect(callbackUrlProblem('https://10.0.0.5/x')).toBe('an IP address, not a host name')
    expect(callbackUrlProblem('https://[::1]/x')).toBe('an IP address, not a host name')
    expect(callbackUrlProblem('nonsense')).toBe('not a valid address')
  })

  it('posts the exact signed body with the signature headers; 2xx is delivered', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    expect(await deliverCallback(cb, fetchImpl as unknown as typeof fetch)).toEqual({ id: 9, ok: true, status: 204 })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe(cb.url)
    expect(init.body).toBe(cb.body) // byte for byte: the signature covers it
    expect(init.headers).toMatchObject({ 'act-signature': cb.signature, 'act-event': 'action.decided', 'act-delivery': '9', 'content-type': 'application/json' })
    expect(init.redirect).toBe('manual')
  })

  it('reports failures plainly for the retry schedule', async () => {
    const answer = (r: Response | Error) => vi.fn(async () => { if (r instanceof Error) throw r; return r }) as unknown as typeof fetch
    expect(await deliverCallback(cb, answer(new Response('', { status: 500 })))).toEqual({ id: 9, ok: false, status: 500, error: 'HTTP 500' })
    expect(await deliverCallback(cb, answer(new Response('', { status: 302 })))).toEqual({ id: 9, ok: false, status: 302, error: 'HTTP 302' })
    expect(await deliverCallback(cb, answer(Object.assign(new Error('t'), { name: 'TimeoutError' })))).toEqual({ id: 9, ok: false, error: 'no answer within 10 seconds' })
    expect(await deliverCallback(cb, answer(new Error('ECONNREFUSED')))).toEqual({ id: 9, ok: false, error: 'could not connect: ECONNREFUSED' })
    const never = vi.fn()
    expect(await deliverCallback({ ...cb, url: 'https://127.0.0.1/x' }, never as unknown as typeof fetch)).toMatchObject({ ok: false, error: 'callback address an IP address, not a host name' })
    expect(never).not.toHaveBeenCalled()
  })

  it('the dispatcher delivers claimed callbacks and reports them with alerts and emails', async () => {
    const TOKEN = 'pdt_' + 'c'.repeat(64)
    const calls: { url: string; body: unknown }[] = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body })
      if (url.endsWith('/rpc/push_claim')) return new Response(JSON.stringify({ messages: [], emails: [], callbacks: [cb, null] }), { status: 200 })
      if (url.endsWith('/rpc/push_report')) return new Response('1', { status: 200 })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const out = await dispatch(TOKEN, fetchImpl)
    expect(out.callbacks).toEqual([{ id: 9, ok: true, status: 200 }])
    expect(calls.map((c) => c.url)).toContain(cb.url)
    expect(JSON.parse(calls.at(-1)!.body as string).p_results.callback).toEqual([{ id: 9, ok: true, status: 200 }])
  })
})

describe('POST /api/v1/demo-agent/callback (agent console receiver)', () => {
  it('needs the signature header, and passes the exact body and signature to the database', async () => {
    const bad = await demoReceive({ request: new Request('https://act.test/x', { method: 'POST', body: cb.body }) })
    expect(bad.status).toBe(400)
    const fetchMock = vi.fn(async () => new Response('"ok"', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const ok = await demoReceive({ request: new Request('https://act.test/x', { method: 'POST', body: cb.body, headers: { 'act-signature': cb.signature } }) })
    expect(ok.status).toBe(200)
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ p_body: cb.body, p_signature: cb.signature })
    vi.unstubAllGlobals()
  })

  it('a signature the database rejects is a 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: '28000', message: 'Signature does not match' }), { status: 401 })))
    const res = await demoReceive({ request: new Request('https://act.test/x', { method: 'POST', body: cb.body, headers: { 'act-signature': cb.signature } }) })
    expect(res.status).toBe(401)
    vi.unstubAllGlobals()
  })
})
