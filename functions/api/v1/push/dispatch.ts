import { problem, rpc, json } from '../../../../functions-lib/api'
import { sendPush, type PushSubscriptionKeys, type Vapid } from '../../../../functions-lib/webpush'

interface Message { id: number; title: string; body: string; url: string; tag: string; subscriptions: (PushSubscriptionKeys & { id: string })[] }
interface Claimed { vapid?: Vapid; messages: Message[] }
interface Result { id: number; delivered: string[]; gone: string[]; failed: { id: string; error: string }[] }

/** Sends every claimed alert to every device of its person, then reports what happened. */
export async function dispatch(token: string, fetchImpl: typeof fetch = fetch): Promise<{ sent: number; results: Result[] }> {
  const claimed = await rpc<Claimed>('push_claim', { p_token: token }, fetchImpl)
  if (!claimed.ok || !claimed.data.vapid || claimed.data.messages.length === 0) return { sent: 0, results: [] }
  const vapid = claimed.data.vapid
  const results = await Promise.all(claimed.data.messages.map(async (m): Promise<Result> => {
    const r: Result = { id: m.id, delivered: [], gone: [], failed: [] }
    await Promise.all(m.subscriptions.map(async (s) => {
      const out = await sendPush(s, { title: m.title, body: m.body, url: m.url, tag: m.tag }, vapid, { topic: m.tag, fetchImpl })
        .catch((e: Error) => ({ outcome: 'failed' as const, status: 0, error: e.message }))
      if (out.outcome === 'delivered') r.delivered.push(s.id)
      else if (out.outcome === 'gone') r.gone.push(s.id)
      else r.failed.push({ id: s.id, error: out.error ?? 'push service error' })
    }))
    return r
  }))
  await rpc('push_report', { p_token: token, p_results: results }, fetchImpl)
  return { sent: results.reduce((n, r) => n + r.delivered.length, 0), results }
}

/**
 * POST /api/v1/push/dispatch   body: { "token": "pdt_..." }
 * Called by the database (pg_net) right after alerts are queued. The token is single-use and only the database
 * can make one, so this endpoint needs no other secret. Answers at once and sends in the background.
 */
export async function onRequestPost({ request, waitUntil }: { request: Request; waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null
  const token = typeof body?.token === 'string' ? body.token : ''
  if (!/^pdt_[0-9a-f]{64}$/.test(token)) return problem(400, 'invalid_request', 'Send {"token": "..."} from the database.')
  waitUntil(dispatch(token).catch(() => undefined))
  return json(202, { accepted: true })
}
