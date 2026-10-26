import { chromium, expect, test, type Page } from '@playwright/test'

// Task 2.6: real phone alerts, end to end, in Google Chrome (the "push" project in playwright.config.ts).
// Chrome subscribes through Google's push service; our database queues the alert, our Cloudflare function encrypts
// and sends it, and Chrome's service worker shows it. The test reads the shown notifications from the service worker.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const AGENT_KEY = process.env.ACT_AGENT_KEY ?? ''

async function signIn(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

/** Titles and bodies of the notifications the app's service worker is showing. */
const shown = (page: Page) => page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready
  return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body }))
})

test('alerts reach the approver\'s browser: a test alert, then a real £2m request @push', async ({ request, baseURL }, info) => {
  test.skip(!AGENT_KEY, 'ACT_AGENT_KEY is set by the e2e workflow')
  // A normal (persistent) Chrome profile: Playwright's usual contexts are incognito-like, and Chrome refuses push there
  // ("Registration failed - permission denied"). Background networking stays on: Chrome needs it to reach its push service.
  const context = await chromium.launchPersistentContext(info.outputPath('chrome-profile'), {
    channel: 'chrome', headless: false, baseURL, permissions: ['notifications'],
    ignoreDefaultArgs: ['--disable-background-networking'],
  })
  const page = context.pages()[0] ?? await context.newPage()
  await signIn(page, 'ravi.menon')
  await page.getByRole('link', { name: 'Approvals' }).first().click()
  const card = page.getByTestId('alerts-card')
  await expect(card).toBeVisible()

  // Turn alerts on (or they may still be on from an earlier run of this browser profile).
  const turnOn = card.getByRole('button', { name: 'Turn on alerts' })
  if (await turnOn.isVisible()) {
    await turnOn.click()
    // Success and failure both show a message here; on failure this prints the reason.
    await expect(card.getByRole('status')).toHaveText('Alerts are on. Send a test to check.', { timeout: 20_000 })
  }
  await expect(card.getByTestId('alerts-state')).toHaveText(/Alerts are on for this device/)

  // A test alert arrives.
  const t0 = Date.now()
  await card.getByRole('button', { name: 'Send a test alert' }).click()
  await expect(card.getByRole('status')).toHaveText('Test alert sent. It should arrive in a few seconds.')
  await expect.poll(async () => (await shown(page)).map((n) => n.title), { timeout: 30_000 }).toContain('Test alert')
  const testMs = Date.now() - t0

  // The agent asks for £2m; the large-payments rule sends it to Ravi, and his browser shows the alert.
  const stamp = `E2E ${Date.now()}`
  const t1 = Date.now()
  const asked = await request.post('/api/v1/actions/request', {
    headers: { authorization: `Bearer ${AGENT_KEY}`, 'idempotency-key': stamp },
    data: { action: 'payment.release', amount: 2000000, currency: 'GBP', description: `Release £2,000,000 to supplier ${stamp}`, reasoning: 'Alert test', details: { test: true } },
  })
  expect(asked.status()).toBe(201)
  const { request_code: code } = await asked.json()
  await expect.poll(async () => (await shown(page)).find((n) => n.body.includes(stamp)), { timeout: 30_000 })
    .toEqual({ title: `Approval needed · ${code}`, body: `Payment Release Assistant wants to release £2,000,000 to supplier ${stamp}` })
  const requestMs = Date.now() - t1
  console.log(`[push] alert arrived: test ${testMs} ms, request ${requestMs} ms`)
  info.annotations.push({ type: 'alert arrived', description: `test ${testMs} ms, request ${requestMs} ms` })

  // Tidy up: reject the request, and turn alerts off so the test device does not linger in the database.
  await page.goto('/approvals')
  await page.getByTestId('request-card').filter({ hasText: stamp }).click()
  await expect(page.getByTestId('request-headline')).toContainText(stamp)
  await page.getByRole('button', { name: 'Reject' }).click()
  await page.getByLabel('Reason', { exact: true }).fill('E2E alert test, not a real payment')
  await page.getByRole('button', { name: 'Confirm rejection' }).click()
  await expect(page.getByTestId('request-outcome')).toContainText('Rejected by Ravi Menon')
  await page.goto('/approvals')
  await page.getByTestId('alerts-card').getByRole('button', { name: 'Turn off' }).click()
  await expect(page.getByTestId('alerts-card').getByRole('status')).toHaveText('Alerts are off for this device.')
  await context.close()
})
