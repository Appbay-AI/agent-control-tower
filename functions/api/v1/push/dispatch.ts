import { problem, rpc, json } from '../../../../functions-lib/api'
import { deliverCallback, type CallbackResult, type SignedCallback } from '../../../../functions-lib/callback'
import { sendAlertEmail, sendApprovalEmail, sendReactivationEmail, type AlertEmail, type EmailSettings, type QueuedEmail, type ReactivationEmail, type SendResult } from '../../../../functions-lib/email'
import { sendPush, type PushSubscriptionKeys, type Vapid } from '../../../../functions-lib/webpush'

interface Message { id: number; title: string; body: string; url: string; tag: string; subscriptions: (PushSubscriptionKeys & { id: string })[] }
interface Claimed { vapid?: Vapid; messages: Message[]; email?: EmailSettings; emails?: (QueuedEmail | AlertEmail | ReactivationEmail)[]; callbacks?: (SignedCallback | null)[] }
interface Result { id: number; delivered: string[]; gone: string[]; failed: { id: string; error: string }[] }

async function sendAlerts(vapid: Vapid | undefined, messages: Message[], fetchImpl: typeof fetch): Promise<Result[]> {
  if (!vapid) return []
  return Promise.all(messages.map(async (m): Promise<Result> => {
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
}

/** One at a time, to stay well inside Resend's rate limit (10 requests a second per team). */
async function sendEmails(settings: EmailSettings | undefined, emails: (QueuedEmail | AlertEmail | ReactivationEmail)[], fetchImpl: typeof fetch): Promise<SendResult[]> {
  if (!settings) return []
  const out: SendResult[] = []
  for (const e of emails) {
    // Task 5.1: alert emails carry an alert snapshot instead of a request.
    // Task 5.3: reactivation emails carry the request to switch an agent back on.
    const send = 'alert' in e ? sendAlertEmail(e, settings, fetchImpl)
      : 'reactivation' in e ? sendReactivationEmail(e, settings, fetchImpl)
        : sendApprovalEmail(e, settings, fetchImpl)
    out.push(await send.catch((err: Error) => ({ id: e.id, sent: false, error: err.message, retry: true })))
  }
  return out
}

/** Sends every claimed phone alert (2.6), email (2.7) and decision callback (2.8), then reports what happened. */
export async function dispatch(token: string, fetchImpl: typeof fetch = fetch):
  Promise<{ sent: number; results: Result[]; emails: SendResult[]; callbacks: CallbackResult[] }> {
  const claimed = await rpc<Claimed>('push_claim', { p_token: token }, fetchImpl)
  if (!claimed.ok) return { sent: 0, results: [], emails: [], callbacks: [] }
  const c = claimed.data
  const [results, emails, callbacks] = await Promise.all([
    sendAlerts(c.vapid, c.messages ?? [], fetchImpl),
    sendEmails(c.email, c.emails ?? [], fetchImpl),
    Promise.all((c.callbacks ?? []).filter((x): x is SignedCallback => x !== null).map((cb) => deliverCallback(cb, fetchImpl))),
  ])
  if (results.length > 0 || emails.length > 0 || callbacks.length > 0) {
    await rpc('push_report', { p_token: token, p_results: { push: results, email: emails, callback: callbacks } }, fetchImpl)
  }
  const sent = results.reduce((n, r) => n + r.delivered.length, 0) + emails.filter((e) => e.sent).length + callbacks.filter((x) => x.ok).length
  return { sent, results, emails, callbacks }
}

/**
 * POST /api/v1/push/dispatch   body: { "token": "pdt_..." }
 * Called by the database (pg_net) right after alerts, emails or callbacks are queued. The token is single-use and only the database
 * can make one, so this endpoint needs no other secret. Answers at once and sends in the background.
 */
export async function onRequestPost({ request, waitUntil }: { request: Request; waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null
  const token = typeof body?.token === 'string' ? body.token : ''
  if (!/^pdt_[0-9a-f]{64}$/.test(token)) return problem(400, 'invalid_request', 'Send {"token": "..."} from the database.')
  waitUntil(dispatch(token).catch(() => undefined))
  return json(202, { accepted: true })
}
