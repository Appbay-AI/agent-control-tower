// @vitest-environment node
// Task 4.2: our API's side of stopping a suspended agent.
import { describe, expect, it, vi } from 'vitest'
import { deliverCallback } from '../functions-lib/callback'
import { buildStopEmail, sendStopEmail, type EmailSettings, type StopEmail } from '../functions-lib/email'
import { blockOnPlatform, runEnforcement } from '../functions-lib/enforce'

const SITE = 'https://appbay-demo.appiancloud.com'
const conn = { id: 'c1', kind: 'appian_simulator', name: 'Northbridge Agent Platform (simulated)', base_url: SITE, secret: 'k' }
const work = { id: 11, external_id: 'NAP-001', reason: 'Suspended in Agent Control Tower (AGT-0041): Incident INC-0007', connection: conn }

/** A stand-in Appian: records status changes; `stuck` keeps the agent active whatever is asked. */
function appian(opts: { stuck?: boolean; down?: boolean } = {}) {
  let status = 'active'
  const sets: unknown[] = []
  const reply = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code })
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (opts.down) throw new TypeError('fetch failed')
    const url = String(input)
    if (url.endsWith('nap-agent-status-set')) {
      const b = JSON.parse(String(init?.body))
      sets.push(b)
      if (!opts.stuck) status = b.status
      return reply(200, { externalId: 'NAP-001', status: b.status })
    }
    if (url.includes('nap-agent-status?')) return reply(200, { externalId: 'NAP-001', status })
    return reply(404, { error: 'no' })
  }) as unknown as typeof fetch
  return { fetchImpl, sets }
}

const settings: EmailSettings = { api_key: 're_x', from: 'Agent Control Tower <onboarding@resend.dev>', redirect_to: 'inbox@appbaytech.com',
  site_url: 'https://agent-control-tower-56p.pages.dev' }
const email: StopEmail = { id: 21, to_name: 'Lucy Grant', to_email: 'lucy.grant@northbridge.demo', owner: true, reason: 'Refunds <script>',
  suspended_at: '2026-11-03T10:00:00Z', suspended_by: 'Ravi Menon',
  agent: { id: 'a1', code: 'AGT-0050', name: 'Shadow Bot', department: 'Customer Service', systems: ['CRM'] } }

describe('blocking a suspended agent on its platform (task 4.2)', () => {
  it('blocks it, reads it back, and records the reason in the platform', async () => {
    const a = appian()
    expect(await blockOnPlatform(work, a.fetchImpl)).toEqual({ id: 11, ok: true,
      detail: 'Blocked on Northbridge Agent Platform (simulated) as NAP-001; read back as blocked' })
    expect(a.sets).toEqual([{ externalId: 'NAP-001', status: 'quarantined', requestedBy: 'act-integration',
      reason: 'Suspended in Agent Control Tower (AGT-0041): Incident INC-0007' }])
  })

  it('does not count a block the platform does not confirm, or one it never received', async () => {
    // The set call answers "quarantined" but a read-back still says active: the plug-in itself refuses to believe it.
    expect(await blockOnPlatform(work, appian({ stuck: true }).fetchImpl)).toMatchObject({ ok: false })
    const down = await blockOnPlatform(work, appian({ down: true }).fetchImpl)
    expect(down).toMatchObject({ ok: false, detail: expect.stringMatching(/^Not blocked on Northbridge Agent Platform \(simulated\) as NAP-001: Could not connect/) })
  })
})

describe('stop requests and owner emails (task 4.2)', () => {
  it('a stop request carries the agent.stop event, and no signature header when the agent has no key', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }))
    const r = await deliverCallback({ id: 5, url: 'https://agent.example.com/stop', body: '{"event":"agent.stop"}', request_id: '',
      signature: null, event: 'agent.stop' }, fetchImpl as unknown as typeof fetch)
    expect(r).toEqual({ id: 5, ok: true, status: 202 })
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }])[1].headers
    expect(headers['act-event']).toBe('agent.stop')
    expect(headers).not.toHaveProperty('act-signature')
  })

  it('the owner email says what, why, who, and links to the agent; the demo copy is marked', () => {
    const m = buildStopEmail(email, settings, true)
    expect(m.subject).toBe('[For Lucy Grant] Action needed: switch off Shadow Bot (AGT-0050)')
    expect(m.text).toContain('the Control Tower has no way to stop it itself')
    expect(m.text).toContain('Suspended by: Ravi Menon')
    expect(m.text).toContain('See the agent: https://agent-control-tower-56p.pages.dev/agents/a1')
    expect(m.html).toContain('Refunds &lt;script&gt;')
    expect(buildStopEmail({ ...email, owner: false }, settings, false).text).toContain('It has no business owner, so every admin is asked.')
  })

  it('sends through Resend once per step (idempotency key), to the demo inbox when one is set', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }))
    expect(await sendStopEmail(email, settings, fetchImpl as unknown as typeof fetch)).toMatchObject({ sent: true, sent_to: 'inbox@appbaytech.com' })
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }])[1]
    expect(init.headers['idempotency-key']).toBe('act-stop-21')
    expect(JSON.parse(String(init.body)).to).toEqual(['inbox@appbaytech.com'])
  })
})

describe('running the work handed over by the database (task 4.2)', () => {
  it('claims, does each step, and reports every result', async () => {
    const a = appian()
    const reports: unknown[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/rpc/enforcement_claim')) {
        return new Response(JSON.stringify({ platform: [work], email: null, emails: [{ ...email, id: 23 }],
          webhooks: [{ id: 22, url: 'https://agent.example.com/stop', body: '{}', request_id: '', signature: 't=1,v1=ab', event: 'agent.stop' }] }), { status: 200 })
      }
      if (url.endsWith('/rpc/enforcement_report')) { reports.push(JSON.parse(String(init?.body))); return new Response('3', { status: 200 }) }
      if (url.startsWith('https://agent.example.com')) return new Response(null, { status: 200 })
      return a.fetchImpl(input, init)
    }) as unknown as typeof fetch
    const out = await runEnforcement('ent_' + 'a'.repeat(64), fetchImpl)
    expect(out).toEqual([
      { id: 11, ok: true, detail: 'Blocked on Northbridge Agent Platform (simulated) as NAP-001; read back as blocked' },
      { id: 22, ok: true, detail: 'Stop request delivered (HTTP 200)' },
      { id: 23, ok: false, detail: 'Not sent: email is not set up for this site' },
    ])
    expect(reports).toEqual([{ p_token: 'ent_' + 'a'.repeat(64), p_results: out }])
  })

  it('the endpoint accepts only an enforcement token', async () => {
    const { onRequestPost } = await import('./api/v1/enforce/run')
    const later: Promise<unknown>[] = []
    const res = await onRequestPost({ request: new Request('https://x.test/api/v1/enforce/run', { method: 'POST', body: JSON.stringify({ token: 'pjt_' + 'a'.repeat(64) }) }),
      waitUntil: (p) => { later.push(p) } })
    expect(res.status).toBe(400)
    expect(later).toHaveLength(0)
  })
})
