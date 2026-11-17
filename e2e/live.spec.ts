import { expect, test, type Page } from '@playwright/test'
import { cardSeenAt, liveBreakdown, waitForListLoaded, watchForCard } from './helpers.js'

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
// A key for the Payment Release Assistant, made by the e2e workflow for this run and revoked after it.
const AGENT_KEY = process.env.ACT_AGENT_KEY ?? ''
/** Task 2.5 acceptance: the task is on the approver's screen within 2 seconds of being raised. */
const WITHIN_MS = 2000

async function signIn(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

test('a new agent action appears on the approver\'s open screen within 2 seconds, without a reload @phone', async ({ page, request }, info) => {
  test.skip(!AGENT_KEY, 'ACT_AGENT_KEY is set by the e2e workflow')
  const stamp = `E2E ${Date.now()}`

  // Ravi has the Approvals screen open and it says it is live.
  await signIn(page, 'ravi.menon')
  await page.getByRole('link', { name: 'Approvals' }).first().click()
  await expect(page.getByTestId('live-status')).toHaveText('Live')
  await waitForListLoaded(page)
  const card = page.getByTestId('request-card').filter({ hasText: stamp })
  await expect(card).toHaveCount(0)
  let reloaded = false
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) reloaded = true })
  await watchForCard(page, stamp) // records the exact moment the card appears (see helpers.ts)

  // The agent asks to release £2m; the large-payments rule sends it to Ravi.
  const asked = await request.post('/api/v1/actions/request', {
    headers: { authorization: `Bearer ${AGENT_KEY}`, 'idempotency-key': stamp },
    data: {
      action: 'payment.release', amount: 2000000, currency: 'GBP', target_system: 'SWIFT gateway',
      description: `Release £2,000,000 to supplier ${stamp}`, reasoning: 'Live update test',
      details: { test: true }, // test request: no email is sent (task 2.7)
    },
  })
  expect(asked.status()).toBe(201)
  const raisedAt = Date.now()
  const code = ((await asked.json()) as { request_code: string }).request_code

  await expect(card).toBeVisible({ timeout: 10_000 })
  const took = (await cardSeenAt(page, stamp))! - raisedAt
  const parts = await liveBreakdown(page, stamp, raisedAt)
  info.annotations.push({ type: 'appeared after', description: `${took} ms (${parts})` })
  console.log(`[${info.project.name}] task appeared ${took} ms after it was raised (${parts})`)
  expect(took, `task appeared after ${took} ms (${parts})`).toBeLessThanOrEqual(WITHIN_MS)
  expect(reloaded, 'the page must not reload').toBe(false)

  // Task 5.4: the in-app notification that goes with Ravi's email (none is sent for a test request; the notification
  // is made all the same) is in his bell within 2 seconds, without a reload.
  const title = `Approval needed · ${code}`
  const notifiedAt = await page.waitForFunction((name) => {
    const m = performance.getEntriesByName(name)
    return m.length ? performance.timeOrigin + m[0].startTime : null
  }, `act:notification:${title}`, { timeout: 10_000 }).then((h) => h.jsonValue() as Promise<number>)
  const tookN = Math.round(notifiedAt - raisedAt)
  info.annotations.push({ type: 'notification after', description: `${tookN} ms` })
  console.log(`[${info.project.name}] notification arrived ${tookN} ms after it was raised`)
  expect(tookN, `notification after ${tookN} ms`).toBeLessThanOrEqual(WITHIN_MS)
  await page.getByTestId('notification-bell').click()
  await expect(page.getByTestId('notification-item').filter({ hasText: title })).toHaveAttribute('data-unread', 'true')
  await page.getByTestId('notification-bell').click()

  // It is marked new, and the Approvals link shows a count (other tests may add tasks at the same time, so not an exact number).
  await expect(card.getByText('New', { exact: true })).toBeVisible()
  await expect(page.getByTestId('waiting-count').first()).toHaveText(/^[1-9]\d*\+?$/)

  // Tidy up: Ravi rejects it, and it leaves his list.
  await card.click()
  await expect(page.getByTestId('request-headline')).toContainText(stamp)
  await page.getByRole('button', { name: 'Reject' }).click()
  await page.getByLabel('Reason', { exact: true }).fill('E2E live update test, not a real payment')
  await page.getByRole('button', { name: 'Confirm rejection' }).click()
  await expect(page.getByTestId('request-outcome')).toContainText('Rejected by Ravi Menon')
})
