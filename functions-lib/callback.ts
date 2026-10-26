// Task 2.8: delivering a decision to the agent's callback_url. The database has already built and signed the body.

export interface SignedCallback { id: number; url: string; body: string; signature: string; request_id: string }
export interface CallbackResult { id: number; ok: boolean; status?: number; error?: string }

/** Addresses we refuse to call: not https, or pointing at a machine name / private address instead of a public host. */
export function callbackUrlProblem(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'not a valid address'
  }
  if (u.protocol !== 'https:') return 'must use https'
  const h = u.hostname.toLowerCase()
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[')) return 'an IP address, not a host name'
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return 'not a public address'
  return null
}

/** POSTs one signed decision. Any 2xx counts as delivered; the agent has 10 seconds to answer. */
export async function deliverCallback(cb: SignedCallback, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<CallbackResult> {
  const bad = callbackUrlProblem(cb.url)
  if (bad) return { id: cb.id, ok: false, error: `callback address ${bad}` }
  try {
    const res = await fetchImpl(cb.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'AgentControlTower-Callback/1',
        'act-signature': cb.signature,
        'act-event': 'action.decided',
        'act-delivery': String(cb.id),
      },
      body: cb.body,
      redirect: 'manual', // a redirect is not a delivery
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status >= 200 && res.status < 300) return { id: cb.id, ok: true, status: res.status }
    return { id: cb.id, ok: false, status: res.status, error: `HTTP ${res.status}` }
  } catch (e) {
    const name = (e as Error).name
    return { id: cb.id, ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'no answer within 10 seconds' : `could not connect: ${(e as Error).message}` }
  }
}
