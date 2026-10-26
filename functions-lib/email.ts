// Task 2.7: approval emails, written here and sent through Resend's HTTP API (https://resend.com/docs/api-reference).

export interface EmailSettings {
  api_key: string
  from: string // e.g. "Agent Control Tower <onboarding@resend.dev>" (temporary) or "<approvals@notify.appbaytech.com>"
  redirect_to: string | null // demo / temporary inbox: every email goes here, marked with who it was for
  site_url: string
}

export interface QueuedEmail {
  id: number
  kind: 'new' | 'escalated'
  test: boolean // the agent marked the request as a test: send to Resend's test inbox, never to a person
  to_name: string
  to_email: string | null
  request: {
    id: string; code: string; agent: string; headline: string
    reasoning: string | null; hold_reason: string | null
    amount: number | null; currency: string | null; urgency: string | null; requested_at: string
    escalated_by: string | null; escalation_reason: string | null
  }
}

/** Resend's address for test sends: accepted and recorded as delivered, reaches nobody. */
export const TEST_INBOX = 'delivered@resend.dev'
const NOT_REAL = /\.(demo|test|example|invalid|localhost|local)$/i
const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Where this email may go, or why it must not be sent. */
export function chooseRecipient(e: Pick<QueuedEmail, 'test' | 'to_email'>, s: Pick<EmailSettings, 'from' | 'redirect_to'>):
  { to: string; redirected: boolean } | { skip: string } {
  if (e.test) return { to: TEST_INBOX, redirected: false }
  if (s.redirect_to) return { to: s.redirect_to, redirected: true }
  // Resend's test sender delivers only to the account's own address, so without a redirect inbox it would fail.
  if (/@resend\.dev>?\s*$/i.test(s.from)) return { skip: 'the temporary sender needs a redirect inbox' }
  const to = e.to_email?.trim() ?? ''
  if (!ADDRESS.test(to)) return { skip: 'no email address for this person' }
  if (NOT_REAL.test(to.split('@')[1])) return { skip: `${to} is not a real mailbox` }
  return { to, redirected: false }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function formatAmount(amount: number | null, currency: string | null): string | null {
  if (amount == null) return null
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP', maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(amount)
  } catch {
    return `${currency ?? ''} ${amount}`.trim()
  }
}

/** Subject, HTML and plain text for one approval email. */
export function buildApprovalEmail(e: QueuedEmail, s: Pick<EmailSettings, 'site_url'>, redirected: boolean) {
  const r = e.request
  const link = `${s.site_url}/approvals/requests/${r.id}`
  const lead = e.kind === 'escalated' ? 'Escalated to you' : 'Approval needed'
  const subject = `${redirected ? `[For ${e.to_name}] ` : ''}${lead}: ${r.headline} (${r.code})`.slice(0, 250)
  const amount = formatAmount(r.amount, r.currency)
  const rows: [string, string][] = [
    ['Request', r.code],
    ...(amount ? [['Amount', amount] as [string, string]] : []),
    ...(r.reasoning ? [['Because', r.reasoning] as [string, string]] : []),
    ...(r.hold_reason ? [['Why it needs a person', r.hold_reason] as [string, string]] : []),
    ...(e.kind === 'escalated' && r.escalated_by ? [['Escalated by', `${r.escalated_by}${r.escalation_reason ? `: ${r.escalation_reason}` : ''}`] as [string, string]] : []),
    // Task 2.9: the time limit passed and the rule sent it on.
    ...(e.kind === 'escalated' && !r.escalated_by && r.escalation_reason ? [['Escalated automatically', r.escalation_reason] as [string, string]] : []),
    ...(r.urgency && r.urgency !== 'normal' ? [['Urgency', r.urgency[0].toUpperCase() + r.urgency.slice(1)] as [string, string]] : []),
  ]
  const demoNote = redirected
    ? `Demo copy: this email is for ${e.to_name}${e.to_email ? ` (${e.to_email})` : ''}. In live use it goes to them directly.`
    : null

  const text = [
    ...(demoNote ? [demoNote, ''] : []),
    `${lead}, ${e.to_name}.`,
    '',
    r.headline,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `Open the task to approve, reject or escalate: ${link}`,
    '',
    'The agent waits until a person decides. — Agent Control Tower',
  ].join('\n')

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#20242c">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e3e5e8">
<tr><td style="padding:16px 24px;background:#20242c;color:#ffffff;border-radius:8px 8px 0 0;font-weight:bold">Agent Control Tower</td></tr>
${demoNote ? `<tr><td style="padding:12px 24px;background:#fff6cc;font-size:13px">${esc(demoNote)}</td></tr>` : ''}
<tr><td style="padding:24px">
<p style="margin:0 0 4px;font-size:13px;color:#5b6270">${esc(lead)}, ${esc(e.to_name)}</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${esc(r.headline)}</h1>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
${rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#5b6270;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`).join('\n')}
</table>
<p style="margin:24px 0"><a href="${esc(link)}" style="display:inline-block;background:#20242c;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">Open the task</a></p>
<p style="margin:0;font-size:12px;color:#5b6270">Approve, reject with a reason, or escalate. The agent waits until a person decides.</p>
</td></tr></table></body></html>`

  return { subject, html, text }
}

export interface SendResult { id: number; sent: boolean; provider_id?: string; sent_to?: string; error?: string; retry?: boolean }

/** Sends one queued email through Resend. Retries are safe: the idempotency key makes Resend send it only once. */
export async function sendApprovalEmail(e: QueuedEmail, s: EmailSettings, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const where = chooseRecipient(e, s)
  if ('skip' in where) return { id: e.id, sent: false, error: where.skip, retry: false }
  const { subject, html, text } = buildApprovalEmail(e, s, where.redirected)
  let res: Response
  try {
    res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.api_key}`, 'content-type': 'application/json', 'idempotency-key': `act-email-${e.id}` },
      body: JSON.stringify({ from: s.from, to: [where.to], subject, html, text, tags: [{ name: 'kind', value: `approval_${e.kind}` }] }),
    })
  } catch (err) {
    return { id: e.id, sent: false, sent_to: where.to, error: `Resend unreachable: ${(err as Error).message}`, retry: true }
  }
  const body = (await res.json().catch(() => null)) as { id?: string; message?: string; name?: string } | null
  if (res.ok) return { id: e.id, sent: true, provider_id: body?.id, sent_to: where.to }
  // 429 (too many) and 5xx pass; anything else (bad key, unverified sender, invalid address) needs a person to fix.
  const retry = res.status === 429 || res.status >= 500
  return { id: e.id, sent: false, sent_to: where.to, retry, error: `${res.status} from Resend${body?.message ? `: ${body.message}` : ''}`.slice(0, 250) }
}
