import { expect, test } from '@playwright/test'

// Task 4.1: the kill switch. An admin suspends a Live agent with a reason, in one action; the agent is refused at its
// next status check, well inside the 30-second target. The e2e workflow makes the agent key and puts the agent back to
// Live afterwards (reactivation through an approval is task 4.6).

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const KEY = process.env.ACT_KS_AGENT_KEY ?? ''
const CODE = process.env.ACT_KS_AGENT_CODE ?? ''
const AGENT = 'Mail Room Router'

test('an admin suspends a Live agent in one action, and the agent is refused at its next check', async ({ page, request }, info) => {
  test.skip(!PASSWORD || !KEY || !CODE, 'DEMO_USER_PASSWORD, ACT_KS_AGENT_KEY and ACT_KS_AGENT_CODE are set by the e2e workflow')
  const auth = { authorization: `Bearer ${KEY}` }
  const status = async () => (await (await request.get(`/api/v1/agents/${CODE}/status`, { headers: auth })).json()) as { status: string; may_act: boolean }
  expect(await status()).toMatchObject({ status: 'live', may_act: true })

  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  await page.getByLabel('Search agents').fill(AGENT)
  await page.getByRole('link', { name: AGENT }).first().click()
  await expect(page.getByTestId('agent-code')).toHaveText(CODE)

  const reason = `E2E kill switch ${Date.now()}`
  await page.getByTestId('suspend-button').click()
  await expect(page.getByRole('dialog')).toContainText(`Suspend ${CODE} now?`)
  const confirm = page.getByRole('button', { name: 'Suspend now' })
  await expect(confirm).toBeDisabled() // a reason is required
  await page.getByRole('dialog').getByLabel('Reason').fill(reason)
  const pressed = Date.now()
  await confirm.click()

  // The agent's very next check is refused.
  let answer = { status: '', may_act: true }
  await expect.poll(async () => { answer = await status(); return answer.may_act }, { timeout: 30_000, intervals: [250] }).toBe(false)
  const took = Date.now() - pressed
  expect(answer.status).toBe('suspended')
  expect(took).toBeLessThan(30_000)
  console.log(`[killswitch] agent refused ${took} ms after Suspend now`)
  info.annotations.push({ type: 'kill switch', description: `${took} ms` })

  await expect(page.getByTestId('suspension-done')).toContainText(reason)
  await expect(page.getByTestId('suspension-done')).toContainText('Platform Admin')
  await expect(page.getByTestId('suspend-button')).toHaveCount(0)
  await expect(page.getByText('Kill switch pulled').first()).toBeVisible() // in the activity, from the audit trail
  // Task 4.2: it calls our API, so that is how it is stopped: refused from now on, done at once.
  await expect(page.getByTestId('enforcement-api')).toContainText('Refused from now on')

  // Task 4.4: the suspension opened an incident, owned by the agent's business owner (Tom Becker), due in 7 days (Low).
  const opened = page.getByTestId('incident-row').filter({ hasText: reason })
  await expect(opened).toBeVisible()
  await expect(opened.getByTestId('incident-owner')).toHaveText('Owner: Tom Becker')
  await expect(opened.getByTestId('incident-due')).toHaveText('Resolve within 7 days')
  const code = await opened.getAttribute('data-code')
  expect(code).toMatch(/^INC-\d{4}$/)
  console.log(`[incident] ${code} opened by the suspension, owner Tom Becker, resolve within 7 days`)

  // The agent reports an incident itself through the API; a retry with the same key gets the same incident.
  const body = { title: `E2E reported incident ${Date.now()}`, severity: 'high', details: { test: true } }
  const headers = { ...auth, 'idempotency-key': body.title }
  const first = await request.post('/api/v1/incidents', { headers, data: body })
  expect(first.status()).toBe(201)
  const made = await first.json() as { incident_code: string; owner: string; severity: string; sla_minutes: number; due_at: string }
  expect(made).toMatchObject({ owner: 'Tom Becker', severity: 'high', sla_minutes: 1440 })
  const again = await request.post('/api/v1/incidents', { headers, data: body })
  expect(again.status()).toBe(200)
  expect((await again.json()).incident_code).toBe(made.incident_code)

  // Both are on the Incidents page.
  await page.getByRole('link', { name: 'Incidents' }).first().click()
  await expect(page.getByRole('heading', { name: 'Incidents' })).toBeVisible()
  await expect(page.locator(`[data-testid="incident-row"][data-code="${made.incident_code}"]`)).toContainText('Resolve within 24 h')
  await expect(page.locator(`[data-testid="incident-row"][data-code="${code}"]`)).toContainText(CODE)
})
