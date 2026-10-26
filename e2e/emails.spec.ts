import { expect, test, type Page } from '@playwright/test'

// Task 2.7: an approval email is sent through Resend for a waiting request, and the request page says so.
// The request is marked as a test, so the email goes to Resend's test inbox (delivered@resend.dev), not to a person.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const AGENT_KEY = process.env.ACT_AGENT_KEY ?? ''

async function signIn(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

test('the approver is emailed about a waiting request, and the request page shows it was sent', async ({ page, request }) => {
  test.skip(!AGENT_KEY, 'ACT_AGENT_KEY is set by the e2e workflow')
  const stamp = `E2E ${Date.now()}`
  const asked = await request.post('/api/v1/actions/request', {
    headers: { authorization: `Bearer ${AGENT_KEY}`, 'idempotency-key': stamp },
    data: { action: 'payment.release', amount: 2000000, currency: 'GBP', description: `Release £2,000,000 to supplier ${stamp}`,
      reasoning: 'Email test', details: { test: true } },
  })
  expect(asked.status()).toBe(201)
  const { request_id: id } = await asked.json()

  await signIn(page, 'ravi.menon')
  await page.goto(`/approvals/requests/${id}`)
  await expect(page.getByTestId('request-headline')).toContainText(stamp)
  const email = page.getByTestId('who-was-told').locator('li').filter({ hasText: 'Email to Ravi Menon' })
  // The list is read when the page loads; read it again until the email has gone.
  await expect.poll(async () => {
    await page.reload()
    return (await email.textContent().catch(() => null)) ?? ''
  }, { timeout: 45_000, intervals: [2_000, 3_000, 5_000] }).toMatch(/Sent \(test inbox\)|Not sent: email is not set up yet/)
  const status = await email.textContent()
  test.skip(/not set up yet/.test(status ?? ''), 'RESEND_API_KEY is not set for this database yet')
  await expect(email).toContainText('Sent (test inbox)')

  // Tidy up.
  await page.getByRole('button', { name: 'Reject' }).click()
  await page.getByLabel('Reason', { exact: true }).fill('E2E email test, not a real payment')
  await page.getByRole('button', { name: 'Confirm rejection' }).click()
  await expect(page.getByTestId('request-outcome')).toContainText('Rejected by Ravi Menon')
})
