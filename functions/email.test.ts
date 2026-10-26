// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { buildApprovalEmail, chooseRecipient, formatAmount, sendApprovalEmail, TEST_INBOX, type EmailSettings, type QueuedEmail } from '../functions-lib/email'
import { dispatch } from './api/v1/push/dispatch'

const TEMP_FROM = 'Agent Control Tower <onboarding@resend.dev>'
const settings: EmailSettings = { api_key: 're_key', from: TEMP_FROM, redirect_to: 'rajveer@company.example', site_url: 'https://main.act.pages.dev' }

const email = (over: Partial<QueuedEmail> = {}, req: Partial<QueuedEmail['request']> = {}): QueuedEmail => ({
  id: 41, kind: 'new', test: false, to_name: 'Ravi Menon', to_email: 'ravi.menon@northbridge.demo',
  request: {
    id: 'r-1', code: 'REQ-000001', agent: 'Payment Release Assistant',
    headline: 'Payment Release Assistant wants to release £2,000,000 to supplier Hartwell Steel Ltd',
    reasoning: 'Invoice HS-48817 is due today', hold_reason: 'Value 2,000,000 GBP is outside its limits (up to 250,000 GBP)',
    amount: 2000000, currency: 'GBP', urgency: 'high', requested_at: '2026-10-26T08:00:00Z',
    escalated_by: null, escalation_reason: null, ...req,
  },
  ...over,
})

describe('who an approval email goes to (task 2.7)', () => {
  it('temporary mode: everything goes to the redirect inbox, marked with who it was for', () => {
    expect(chooseRecipient(email(), settings)).toEqual({ to: 'rajveer@company.example', redirected: true })
  })

  it('test requests go to Resend\'s test inbox, never to a person', () => {
    expect(chooseRecipient(email({ test: true }), settings)).toEqual({ to: TEST_INBOX, redirected: false })
  })

  it('never tries the temporary sender without a redirect inbox (Resend would refuse)', () => {
    expect(chooseRecipient(email({ to_email: 'ravi@bank.co.uk' }), { from: TEMP_FROM, redirect_to: null })).toEqual({ skip: 'the temporary sender needs a redirect inbox' })
  })

  it('verified domain: real people get their own email; made-up demo addresses are skipped', () => {
    const live = { from: 'Agent Control Tower <approvals@notify.appbaytech.com>', redirect_to: null }
    expect(chooseRecipient(email({ to_email: 'ravi@bank.co.uk' }), live)).toEqual({ to: 'ravi@bank.co.uk', redirected: false })
    expect(chooseRecipient(email(), live)).toEqual({ skip: 'ravi.menon@northbridge.demo is not a real mailbox' })
    expect(chooseRecipient(email({ to_email: null }), live)).toEqual({ skip: 'no email address for this person' })
  })
})

describe('the approval email', () => {
  it('says what the agent wants, how much, why, why it needs a person, and links to the task', () => {
    const { subject, html, text } = buildApprovalEmail(email(), settings, false)
    expect(subject).toBe('Approval needed: Payment Release Assistant wants to release £2,000,000 to supplier Hartwell Steel Ltd (REQ-000001)')
    expect(text).toContain('Amount: £2,000,000')
    expect(text).toContain('Because: Invoice HS-48817 is due today')
    expect(text).toContain('Why it needs a person: Value 2,000,000 GBP is outside its limits')
    expect(text).toContain('Urgency: High')
    expect(text).toContain('https://main.act.pages.dev/approvals/requests/r-1')
    expect(html).toContain('href="https://main.act.pages.dev/approvals/requests/r-1"')
    expect(html).not.toContain('Demo copy')
  })

  it('in the demo inbox, says who it was for', () => {
    const { subject, html, text } = buildApprovalEmail(email(), settings, true)
    expect(subject.startsWith('[For Ravi Menon] Approval needed: ')).toBe(true)
    expect(text.split('\n')[0]).toBe('Demo copy: this email is for Ravi Menon (ravi.menon@northbridge.demo). In live use it goes to them directly.')
    expect(html).toContain('Demo copy: this email is for Ravi Menon')
  })

  it('on escalation, says who escalated it and why', () => {
    const { subject, text } = buildApprovalEmail(email({ kind: 'escalated', to_name: 'Daniel Okafor' }, { escalated_by: 'Ravi Menon', escalation_reason: 'New supplier' }), settings, false)
    expect(subject.startsWith('Escalated to you: ')).toBe(true)
    expect(text).toContain('Escalated by: Ravi Menon: New supplier')
  })

  it('on an automatic escalation (time limit passed), says so', () => {
    const { text } = buildApprovalEmail(email({ kind: 'escalated', to_name: 'Daniel Okafor' }, { escalated_by: null, escalation_reason: 'No decision within 30 minutes, so it was escalated automatically' }), settings, false)
    expect(text).toContain('Escalated automatically: No decision within 30 minutes, so it was escalated automatically')
    expect(text).not.toContain('Escalated by')
  })

  it('cannot be used to inject HTML through what an agent writes', () => {
    const { html } = buildApprovalEmail(email({}, { reasoning: '<script>alert(1)</script><a href="https://evil">x</a>' }), settings, false)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('href="https://evil"')
  })

  it('formats amounts like the app', () => {
    expect(formatAmount(2000000, 'GBP')).toBe('£2,000,000')
    expect(formatAmount(1234.5, 'USD')).toBe('US$1,234.5')
    expect(formatAmount(null, 'GBP')).toBeNull()
  })
})

describe('sending through Resend', () => {
  it('posts to Resend with the key, the sender, an idempotency key, and both HTML and text', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }))
    const out = await sendApprovalEmail(email(), settings, fetchImpl as unknown as typeof fetch)
    expect(out).toEqual({ id: 41, sent: true, provider_id: 'em_1', sent_to: 'rajveer@company.example' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers).toMatchObject({ authorization: 'Bearer re_key', 'idempotency-key': 'act-email-41' })
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ from: TEMP_FROM, to: ['rajveer@company.example'] })
    expect(body.html).toContain('<h1')
    expect(body.text).toContain('Open the task')
  })

  it('retries only what may pass (429, 5xx, network); a refusal needs a person', async () => {
    const answer = (status: number, message: string) => vi.fn(async () => new Response(JSON.stringify({ message }), { status })) as unknown as typeof fetch
    expect(await sendApprovalEmail(email(), settings, answer(429, 'Too many requests'))).toMatchObject({ sent: false, retry: true, error: '429 from Resend: Too many requests' })
    expect(await sendApprovalEmail(email(), settings, answer(503, 'down'))).toMatchObject({ sent: false, retry: true })
    expect(await sendApprovalEmail(email(), settings, answer(403, 'You can only send testing emails to your own email address'))).toMatchObject({ sent: false, retry: false })
    const offline = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await sendApprovalEmail(email(), settings, offline)).toMatchObject({ sent: false, retry: true })
  })

  it('does not call Resend at all for an email that must not be sent', async () => {
    const fetchImpl = vi.fn()
    const out = await sendApprovalEmail(email(), { ...settings, redirect_to: null }, fetchImpl as unknown as typeof fetch)
    expect(out).toEqual({ id: 41, sent: false, error: 'the temporary sender needs a redirect inbox', retry: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('the dispatcher sends claimed emails and reports them with the alerts', async () => {
    const TOKEN = 'pdt_' + 'b'.repeat(64)
    const calls: { url: string; body: string }[] = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string })
      if (url.endsWith('/rpc/push_claim')) return new Response(JSON.stringify({ messages: [], email: settings, emails: [email(), email({ id: 42, test: true })] }), { status: 200 })
      if (url.endsWith('/rpc/push_report')) return new Response('2', { status: 200 })
      return new Response(JSON.stringify({ id: `em_${calls.length}` }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await dispatch(TOKEN, fetchImpl)
    expect(out.sent).toBe(2)
    expect(calls.filter((c) => c.url === 'https://api.resend.com/emails').map((c) => JSON.parse(c.body).to[0])).toEqual(['rajveer@company.example', TEST_INBOX])
    const report = JSON.parse(calls.at(-1)!.body)
    expect(report.p_results.push).toEqual([])
    expect(report.p_results.email.map((e: { id: number; sent: boolean }) => [e.id, e.sent])).toEqual([[41, true], [42, true]])
  })
})
