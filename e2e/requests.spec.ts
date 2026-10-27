import { expect, test, type Page } from '@playwright/test'

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
// A key for the Payment Release Assistant, made by the e2e workflow for this run and revoked after it.
const AGENT_KEY = process.env.ACT_AGENT_KEY ?? ''

async function signIn(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

async function openTask(page: Page, stamp: string) {
  await page.getByRole('link', { name: 'Approvals' }).first().click()
  await page.getByTestId('request-card').filter({ hasText: stamp }).click()
  await expect(page.getByTestId('request-headline')).toContainText(stamp)
}

test.describe.configure({ mode: 'serial' })

test('an approver sees what the agent wants and why, escalates it, and the next approver approves @phone', async ({ page, request }) => {
  test.skip(!AGENT_KEY, 'ACT_AGENT_KEY is set by the e2e workflow')
  const stamp = `E2E ${Date.now()}`

  // The agent asks to release £2m: above its £250k limit, so it waits; the large-payments rule sends it to Ravi.
  const asked = await request.post('/api/v1/actions/request', {
    headers: { authorization: `Bearer ${AGENT_KEY}`, 'idempotency-key': stamp },
    data: {
      action: 'payment.release', amount: 2000000, currency: 'GBP', target_system: 'SWIFT gateway',
      description: `Release £2,000,000 to supplier ${stamp}`, reasoning: 'Invoice is due today and matches the purchase order',
      details: { supplier: stamp, invoice: 'INV-E2E', test: true }, // test request: no email is sent
    },
  })
  expect(asked.status()).toBe(201)
  const { request_code: code, status } = await asked.json()
  expect(status).toBe('pending')

  // Ravi opens the task: what, how much, why, and why it needs him.
  await signIn(page, 'ravi.menon')
  await openTask(page, stamp)
  await expect(page.getByTestId('request-headline')).toHaveText(`Payment Release Assistant wants to release £2,000,000 to supplier ${stamp}`)
  await expect(page.getByText('Invoice is due today and matches the purchase order')).toBeVisible()
  await expect(page.getByText(/outside its limits/)).toBeVisible()
  await expect(page.getByText(/Assigned to/)).toContainText('Ravi Menon')

  // Rejecting needs a reason.
  await page.getByRole('button', { name: 'Reject' }).click()
  await page.getByRole('button', { name: 'Confirm rejection' }).click()
  await expect(page.getByText('Say why it is rejected.')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  // He escalates it to Daniel, with a reason.
  await page.getByRole('button', { name: 'Escalate' }).click()
  await page.getByLabel('Escalate to').selectOption({ label: 'Daniel Okafor · Payments Risk Lead' })
  await page.getByLabel('Reason').fill('New supplier: needs the Payments Risk Lead')
  await page.getByRole('button', { name: 'Escalate' }).click()
  await expect(page.getByText(`${code} was escalated.`)).toBeVisible()
  await expect(page.getByTestId('request-card').filter({ hasText: stamp })).toHaveCount(0)
  await page.getByRole('button', { name: /sign out/i }).click()

  // Daniel approves it with a note; the agent is told it may proceed.
  await signIn(page, 'daniel.okafor')
  await openTask(page, stamp)
  await expect(page.getByText(/Escalated by Ravi Menon to Daniel Okafor/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await page.getByLabel('Note (optional)').fill('Supplier verified by phone')
  await page.getByRole('button', { name: 'Confirm approval' }).click()
  await expect(page.getByTestId('request-outcome')).toHaveText('Approved by Daniel Okafor: Supplier verified by phone')

  const answer = await (await request.get(`/api/v1/actions/${code}`, { headers: { authorization: `Bearer ${AGENT_KEY}` } })).json()
  expect(answer).toMatchObject({ status: 'approved', may_proceed: true, decision_source: 'human' })
})
