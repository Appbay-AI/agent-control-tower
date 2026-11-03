// Task 4.2: stopping a suspended agent every way the Control Tower can (see migration 20261106000100_enforcement.sql).
import { rpc } from './api'
import { deliverCallback, type SignedCallback } from './callback'
import { sendStopEmail, type EmailSettings, type StopEmail } from './email'
import { PlatformError, pluginFor, type PlatformConnection } from './platforms'

interface PlatformWork { id: number; external_id: string; reason: string; connection: PlatformConnection & { name: string } }
interface Claimed { platform: PlatformWork[]; webhooks: (SignedCallback & { event: string })[]; emails: StopEmail[]; email: EmailSettings | null }
export interface StepResult { id: number; ok: boolean; detail: string }

/** Blocks the agent on its platform, then reads it back: it counts only if the platform says it is blocked. */
export async function blockOnPlatform(w: PlatformWork, fetchImpl: typeof fetch = fetch): Promise<StepResult> {
  const where = `${w.connection.name} as ${w.external_id}`
  try {
    const plugin = pluginFor(w.connection, fetchImpl)
    await plugin.block(w.external_id, { reason: w.reason.slice(0, 250), requestedBy: 'act-integration' })
    const back = await plugin.readStatus(w.external_id)
    if (back.status !== 'blocked') return { id: w.id, ok: false, detail: `Asked ${where} to block it, but it still reads as ${back.status}` }
    return { id: w.id, ok: true, detail: `Blocked on ${where}; read back as blocked` }
  } catch (e) {
    const msg = e instanceof PlatformError ? e.message : `Unexpected error: ${(e as Error).message}`
    return { id: w.id, ok: false, detail: `Not blocked on ${where}: ${msg}`.slice(0, 500) }
  }
}

export async function runEnforcement(token: string, fetchImpl: typeof fetch = fetch): Promise<StepResult[] | null> {
  const claimed = await rpc<Claimed>('enforcement_claim', { p_token: token }, fetchImpl)
  if (!claimed.ok) return null
  const c = claimed.data
  const [platform, webhooks] = await Promise.all([
    Promise.all((c.platform ?? []).map((w) => blockOnPlatform(w, fetchImpl))),
    Promise.all((c.webhooks ?? []).map(async (h): Promise<StepResult> => {
      const r = await deliverCallback(h, fetchImpl)
      return { id: h.id, ok: r.ok, detail: r.ok ? `Stop request delivered (HTTP ${r.status})${h.signature ? '' : ', unsigned: the agent has no key'}`
        : `Stop request not delivered: ${r.error}` }
    })),
  ])
  // One at a time, inside Resend's rate limit.
  const emails: StepResult[] = []
  for (const e of c.emails ?? []) {
    if (!c.email) { emails.push({ id: e.id, ok: false, detail: 'Not sent: email is not set up for this site' }); continue }
    const r = await sendStopEmail(e, c.email, fetchImpl).catch((err: Error) => ({ id: e.id, sent: false, error: err.message, sent_to: undefined }))
    const demo = c.email.redirect_to && r.sent_to === c.email.redirect_to ? ' (demo inbox)' : ''
    emails.push({ id: e.id, ok: r.sent, detail: r.sent ? `Emailed ${e.to_name}, asking them to switch it off${demo}` : `Email to ${e.to_name} not sent: ${r.error}` })
  }
  const results = [...platform, ...webhooks, ...emails]
  await rpc('enforcement_report', { p_token: token, p_results: results }, fetchImpl)
  return results
}
