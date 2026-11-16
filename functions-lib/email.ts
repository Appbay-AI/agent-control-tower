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

// ---------------------------------------------------------------------------------------------------------------
// Task 4.2: "please switch this agent off", to the owner of a suspended agent the Control Tower cannot reach itself.
// ---------------------------------------------------------------------------------------------------------------
export interface StopEmail {
  id: number
  /** Task 4.6: "restore" = switching it back on was approved (suspended_at/by = approved at/by). */
  action?: 'stop' | 'restore'
  to_name: string
  to_email: string | null
  owner: boolean // false: sent to an admin because the agent has no owner
  reason: string | null
  suspended_at: string | null
  suspended_by: string | null
  agent: { id: string; code: string; name: string; department: string | null; systems: string[] }
}

export function buildStopEmail(e: StopEmail, s: Pick<EmailSettings, 'site_url'>, redirected: boolean) {
  const a = e.agent
  const link = `${s.site_url}/agents/${a.id}`
  const restore = e.action === 'restore'
  const subject = `${redirected ? `[For ${e.to_name}] ` : ''}${restore ? `You can switch ${a.name} back on` : `Action needed: switch off ${a.name}`} (${a.code})`.slice(0, 250)
  const why = e.owner ? 'You are its business owner.' : 'It has no business owner, so every admin is asked.'
  const rows: [string, string][] = [
    ['Agent', `${a.name} (${a.code})`],
    ...(a.department ? [['Department', a.department] as [string, string]] : []),
    ...(e.suspended_by ? [[restore ? 'Approved by' : 'Suspended by', e.suspended_by] as [string, string]] : []),
    ...(e.reason ? [['Why', e.reason] as [string, string]] : []),
    ...(a.systems.length ? [['Systems it uses', a.systems.join(', ')] as [string, string]] : []),
  ]
  const demoNote = redirected
    ? `Demo copy: this email is for ${e.to_name}${e.to_email ? ` (${e.to_email})` : ''}. In live use it goes to them directly.`
    : null
  const ask = restore
    ? 'Switching it back on has been approved in Agent Control Tower. The Control Tower cannot switch it on itself, so if you switched it off where it runs, you may now switch it back on.'
    : 'It has been suspended in Agent Control Tower, but the Control Tower has no way to stop it itself: it is not on a connected platform, does not check in through our API, and has no control endpoint. Please switch it off where it runs, today.'
  const heading = restore ? `You can switch ${a.name} back on` : `Please switch off ${a.name}`
  const text = [
    ...(demoNote ? [demoNote, ''] : []),
    restore ? `${e.to_name}, ${a.name} may run again.` : `${e.to_name}, please switch off ${a.name}.`, '', ask, why, '',
    ...rows.map(([k, v]) => `${k}: ${v}`), '',
    `See the agent: ${link}`, '', '— Agent Control Tower',
  ].join('\n')
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#20242c">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e3e5e8">
<tr><td style="padding:16px 24px;background:${restore ? '#067647' : '#b42318'};color:#ffffff;border-radius:8px 8px 0 0;font-weight:bold">Agent Control Tower · ${restore ? 'switched back on' : 'action needed'}</td></tr>
${demoNote ? `<tr><td style="padding:12px 24px;background:#fff6cc;font-size:13px">${esc(demoNote)}</td></tr>` : ''}
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${esc(heading)}</h1>
<p style="margin:0 0 8px;font-size:14px">${esc(ask)}</p>
<p style="margin:0 0 16px;font-size:13px;color:#5b6270">${esc(why)}</p>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
${rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#5b6270;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`).join('\n')}
</table>
<p style="margin:24px 0"><a href="${esc(link)}" style="display:inline-block;background:#20242c;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">See the agent</a></p>
</td></tr></table></body></html>`
  return { subject, html, text }
}

/** Sends one "switch it off" email through Resend (idempotency key per enforcement step, so retries send it once). */
export async function sendStopEmail(e: StopEmail, s: EmailSettings, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const where = chooseRecipient({ test: false, to_email: e.to_email }, s)
  if ('skip' in where) return { id: e.id, sent: false, error: where.skip, retry: false }
  const { subject, html, text } = buildStopEmail(e, s, where.redirected)
  let res: Response
  try {
    res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.api_key}`, 'content-type': 'application/json', 'idempotency-key': `act-${e.action === 'restore' ? 'restore' : 'stop'}-${e.id}` },
      body: JSON.stringify({ from: s.from, to: [where.to], subject, html, text, tags: [{ name: 'kind', value: e.action === 'restore' ? 'agent_restore' : 'agent_stop' }] }),
    })
  } catch (err) {
    return { id: e.id, sent: false, sent_to: where.to, error: `Resend unreachable: ${(err as Error).message}`, retry: true }
  }
  const body = (await res.json().catch(() => null)) as { id?: string; message?: string } | null
  if (res.ok) return { id: e.id, sent: true, provider_id: body?.id, sent_to: where.to }
  return { id: e.id, sent: false, sent_to: where.to, retry: res.status === 429 || res.status >= 500,
    error: `${res.status} from Resend${body?.message ? `: ${body.message}` : ''}`.slice(0, 250) }
}

// ---------------------------------------------------------------------------------------------------------------
// Task 5.1: alert emails (R4.1, R4.2). Seven events; each email carries the owner, everyone who can use the agent
// with their role and department, the data it touches and a red flag when it handles personal data.
// ---------------------------------------------------------------------------------------------------------------
export type AlertEvent = 'suspended' | 'reactivated' | 're_quarantined' | 'enforcement_pending' | 'discovered'
  | 'missing_at_source' | 'access_without_authority'

export interface AlertPerson { name: string; email: string; role: string | null; department: string | null; how: string[]; missing: string[] }
export interface AlertDetails {
  event: AlertEvent
  headline: string
  facts: [string, string][]
  at: string
  /** Why this person gets it (task 5.2: a sentence from their alert route; 'admin' / 'owner' on emails queued by 5.1). */
  because: string
  route?: string | null
  agent: { id: string; code: string; name: string; status: string; risk_tier: string; department: string | null; purpose: string | null }
  owner: { name: string; email: string | null; role: string | null } | null
  technical_owner: { name: string; email: string | null; role: string | null } | null
  data: string[]
  systems: string[]
  pii: boolean
  platform: { name: string; external_id: string; status: string | null; missing_since: string | null } | null
  people: AlertPerson[]
}
export interface AlertEmail { id: number; kind: 'alert'; test: boolean; to_name: string; to_email: string | null; alert: AlertDetails }

/** The label at the top of each event's email, and its colour. */
export const ALERT_EVENT: Record<AlertEvent, { label: string; colour: string }> = {
  suspended: { label: 'Agent suspended', colour: '#b42318' },
  reactivated: { label: 'Agent switched back on', colour: '#067647' },
  re_quarantined: { label: 'Switched on outside Control Tower: blocked again', colour: '#b42318' },
  enforcement_pending: { label: 'Not stopped everywhere yet', colour: '#b54708' },
  discovered: { label: 'New agent found, not registered', colour: '#b54708' },
  missing_at_source: { label: 'Agent missing from its platform', colour: '#b54708' },
  access_without_authority: { label: 'Access without authority', colour: '#b42318' },
}

const DATA_NAME: Record<string, string> = { public: 'Public', internal: 'Internal', confidential: 'Confidential', restricted: 'Restricted', personal: 'Personal' }
const dataName = (k: string) => DATA_NAME[k] ?? k

/** Subject, HTML and plain text for one alert email. */
export function buildAlertEmail(e: AlertEmail, s: Pick<EmailSettings, 'site_url'>, redirected: boolean) {
  const x = e.alert
  const ev = ALERT_EVENT[x.event] ?? { label: 'Alert', colour: '#20242c' }
  const link = `${s.site_url}/agents/${x.agent.id}`
  const pii = x.pii || x.people.some((p) => p.missing.includes('personal'))
  const subject = `${redirected ? `[For ${e.to_name}] ` : ''}${pii ? '[Personal data] ' : ''}${x.headline}`.slice(0, 250)
  const why = x.because === 'owner' ? `You are the business owner of ${x.agent.name}.`
    : x.because === 'admin' ? 'You are an admin of Agent Control Tower.' : x.because
  const person = (p: { name: string; role: string | null } | null) => (p ? `${p.name}${p.role ? `, ${p.role}` : ''}` : 'Nobody named')
  const agentRows: [string, string][] = [
    ['Agent', `${x.agent.name} (${x.agent.code})`],
    ['Status', x.agent.status[0].toUpperCase() + x.agent.status.slice(1)],
    ['Risk tier', x.agent.risk_tier[0].toUpperCase() + x.agent.risk_tier.slice(1)],
    ...(x.agent.department ? [['Department', x.agent.department] as [string, string]] : []),
    ['Business owner', person(x.owner)],
    ...(x.technical_owner ? [['Technical owner', person(x.technical_owner)] as [string, string]] : []),
    ...(x.platform ? [['Runs on', `${x.platform.name} as ${x.platform.external_id}`] as [string, string]] : []),
    ['Data it touches', x.data.length ? x.data.map(dataName).join(', ') : 'None recorded'],
    ...(x.systems.length ? [['Systems', x.systems.join(', ')] as [string, string]] : []),
  ]
  const peopleLine = (p: AlertPerson) =>
    `${p.name} · ${p.role ?? 'role not known'} · ${p.department ?? 'department not known'} · ${p.how.join(', ')}` +
    (p.missing.length ? ` · NOT authorised for ${p.missing.map(dataName).join(', ')}` : '')
  const piiNote = pii
    ? (x.people.some((p) => p.missing.includes('personal'))
        ? 'This agent handles personal data, and someone who can use it is not authorised to see personal data.'
        : 'This agent handles personal data.')
    : null
  const demoNote = redirected
    ? `Demo copy: this email is for ${e.to_name}${e.to_email ? ` (${e.to_email})` : ''}. In live use it goes to them directly.`
    : null
  const when = new Date(x.at).toUTCString().replace(' GMT', ' UTC')

  const text = [
    ...(demoNote ? [demoNote, ''] : []),
    ev.label.toUpperCase(),
    ...(piiNote ? ['', `PERSONAL DATA: ${piiNote}`] : []),
    '', x.headline, `(${when})`, '',
    ...x.facts.map(([k, v]) => `${k}: ${v}`), '',
    'The agent', ...agentRows.map(([k, v]) => `  ${k}: ${v}`), '',
    `Who can use it (${x.people.length})`, ...(x.people.length ? x.people.map((p) => `  ${peopleLine(p)}`) : ['  Nobody recorded']), '',
    `See the agent: ${link}`, '', why, '— Agent Control Tower',
  ].join('\n')

  const td = 'padding:6px 12px 6px 0;color:#5b6270;vertical-align:top;white-space:nowrap'
  const rowsHtml = (rows: [string, string][]) => rows.map(([k, v]) => `<tr><td style="${td}">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`).join('\n')
  const peopleHtml = x.people.length
    ? x.people.map((p) => `<tr${p.missing.length ? ' style="background:#fef3f2"' : ''}>
<td style="padding:6px 8px;border-top:1px solid #e3e5e8">${esc(p.name)}</td>
<td style="padding:6px 8px;border-top:1px solid #e3e5e8">${esc(p.role ?? 'Not known')}</td>
<td style="padding:6px 8px;border-top:1px solid #e3e5e8">${esc(p.department ?? 'Not known')}</td>
<td style="padding:6px 8px;border-top:1px solid #e3e5e8">${esc(p.how.join(', '))}${p.missing.length ? `<br><b style="color:#b42318">Not authorised for ${esc(p.missing.map(dataName).join(', '))}</b>` : ''}</td></tr>`).join('\n')
    : '<tr><td colspan="4" style="padding:6px 8px;border-top:1px solid #e3e5e8;color:#5b6270">Nobody recorded</td></tr>'

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#20242c">
<table role="presentation" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e3e5e8">
<tr><td style="padding:16px 24px;background:${ev.colour};color:#ffffff;border-radius:8px 8px 0 0;font-weight:bold">Agent Control Tower · ${esc(ev.label)}</td></tr>
${demoNote ? `<tr><td style="padding:12px 24px;background:#fff6cc;font-size:13px">${esc(demoNote)}</td></tr>` : ''}
${piiNote ? `<tr><td style="padding:12px 24px;background:#b42318;color:#ffffff;font-size:14px;font-weight:bold">&#9873; Personal data: ${esc(piiNote)}</td></tr>` : ''}
<tr><td style="padding:24px">
<h1 style="margin:0 0 4px;font-size:20px;line-height:1.3">${esc(x.headline)}</h1>
<p style="margin:0 0 16px;font-size:12px;color:#5b6270">${esc(when)}</p>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
${rowsHtml(x.facts)}
</table>
<h2 style="margin:24px 0 8px;font-size:15px">The agent</h2>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
${rowsHtml(agentRows)}
</table>
<h2 style="margin:24px 0 8px;font-size:15px">Who can use it (${x.people.length})</h2>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px">
<tr style="color:#5b6270;text-align:left"><th style="padding:6px 8px">Name</th><th style="padding:6px 8px">Role</th><th style="padding:6px 8px">Department</th><th style="padding:6px 8px">Access</th></tr>
${peopleHtml}
</table>
<p style="margin:24px 0"><a href="${esc(link)}" style="display:inline-block;background:#20242c;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">See the agent</a></p>
<p style="margin:0;font-size:12px;color:#5b6270">${esc(why)}</p>
</td></tr></table></body></html>`
  return { subject, html, text }
}

/** Sends one alert email through Resend (idempotency key per queued email, so retries send it once). */
export async function sendAlertEmail(e: AlertEmail, s: EmailSettings, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const where = chooseRecipient(e, s)
  if ('skip' in where) return { id: e.id, sent: false, error: where.skip, retry: false }
  const { subject, html, text } = buildAlertEmail(e, s, where.redirected)
  let res: Response
  try {
    res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.api_key}`, 'content-type': 'application/json', 'idempotency-key': `act-email-${e.id}` },
      body: JSON.stringify({ from: s.from, to: [where.to], subject, html, text, tags: [{ name: 'kind', value: `alert_${e.alert.event}` }] }),
    })
  } catch (err) {
    return { id: e.id, sent: false, sent_to: where.to, error: `Resend unreachable: ${(err as Error).message}`, retry: true }
  }
  const body = (await res.json().catch(() => null)) as { id?: string; message?: string } | null
  if (res.ok) return { id: e.id, sent: true, provider_id: body?.id, sent_to: where.to }
  return { id: e.id, sent: false, sent_to: where.to, retry: res.status === 429 || res.status >= 500,
    error: `${res.status} from Resend${body?.message ? `: ${body.message}` : ''}`.slice(0, 250) }
}
