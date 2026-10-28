import { devices, expect, test, type Page } from '@playwright/test'
import { cardSeenAt, watchForCard } from './helpers.js'

// Task 2.12: the £2m payment, start to finish, on desktop and on a phone, in one story. This is the demo the client
// will see, run against the real site and database on every change (the e2e workflow runs after each deploy of main).
//
//  1. Ravi Menon has his Approvals list open.
//  2. The Payment Release Assistant checks it may act (status check, check-in) and logs that the invoice matches.
//  3. It asks to release £2,000,000. Above its £250,000 limit, so it must wait; asking again gets the same answer.
//  4. The task appears on Ravi's open list without a reload, marked New and four-eyes (the agent is Critical).
//  5. Ravi reads what, how much, why, why it needs a person, by when, and who was told.
//  6. Ravi approves first; the agent is still told to wait.
//  7. Daniel Okafor, in his own browser, gives the second approval.
//  8. The agent is told it may go ahead, goes ahead (simulated) and logs it against the request.
//  9. It is on record: gone from Ravi's list; the agent's page shows its log, linked to the request.
// Test request: no email is sent (Resend's daily limit), and no money moves anywhere.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
// A key for the Payment Release Assistant, and its code, made by the e2e workflow for this run (key revoked after it).
const AGENT_KEY = process.env.ACT_AGENT_KEY ?? ''
const AGENT_CODE = process.env.ACT_AGENT_CODE ?? ''
const AGENT = 'Payment Release Assistant'

async function signIn(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

test('the £2m payment, start to finish: the agent asks, two approvers decide on the live list, the agent is told and goes ahead @phone',
  async ({ page, browser, request, baseURL }, info) => {
    test.skip(!PASSWORD || !AGENT_KEY || !AGENT_CODE, 'DEMO_USER_PASSWORD, ACT_AGENT_KEY and ACT_AGENT_CODE are set by the e2e workflow')
    test.setTimeout(4 * 60_000)
    const stamp = `E2E ${Date.now()}`
    const supplier = `Hartwell Steel Ltd ${stamp}`
    const auth = { authorization: `Bearer ${AGENT_KEY}` }
    const timings: string[] = []

    // 1. Ravi has his Approvals list open, and it is live.
    await signIn(page, 'ravi.menon')
    await page.getByRole('link', { name: 'Approvals' }).first().click()
    await expect(page.getByTestId('live-status')).toHaveText('Live')
    await watchForCard(page, stamp)
    let reloaded = false
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) reloaded = true })

    // 2. The agent checks it may act (it must not act if it cannot get an answer), checks in, and logs its work.
    const status = await request.get(`/api/v1/agents/${AGENT_CODE}/status`, { headers: auth })
    expect(status.status()).toBe(200)
    expect(await status.json()).toMatchObject({ agent_code: AGENT_CODE, status: 'live', may_act: true })
    const beat = await request.post(`/api/v1/agents/${AGENT_CODE}/heartbeat`, { headers: auth, data: { note: `Paying invoices ${stamp}` } })
    expect(await beat.json()).toMatchObject({ may_act: true })
    const matched = await request.post(`/api/v1/agents/${AGENT_CODE}/logs`, { headers: auth, data: {
      level: 'info', event: 'invoice.matched', message: `Invoice HS-48817 from ${supplier} matches purchase order PO-2026-0912`,
      details: { invoice: 'HS-48817', purchase_order: 'PO-2026-0912' },
    } })
    expect(matched.status()).toBe(201)

    // 3. It asks before acting. £2m is above its £250k limit, so it must wait for people.
    const body = {
      action: 'payment.release', amount: 2000000, currency: 'GBP', target_system: 'SWIFT gateway', urgency: 'high',
      description: `Release £2,000,000 to supplier ${supplier}`,
      reasoning: 'Invoice HS-48817 for the Q4 steel order is due today. It matches purchase order PO-2026-0912 and the goods receipt.',
      details: { supplier, invoice: 'HS-48817', test: true }, // test request: no email is sent
    }
    const asked = await request.post('/api/v1/actions/request', { headers: { ...auth, 'idempotency-key': stamp }, data: body })
    const raisedAt = Date.now()
    expect(asked.status()).toBe(201)
    const first = await asked.json()
    expect(first).toMatchObject({ agent_code: AGENT_CODE, status: 'pending', may_proceed: false, duplicate: false })
    const code: string = first.request_code
    // A retry (same idempotency key) gets the same request back, not a second payment.
    const retry = await request.post('/api/v1/actions/request', { headers: { ...auth, 'idempotency-key': stamp }, data: body })
    expect(retry.status()).toBe(200)
    expect(await retry.json()).toMatchObject({ request_code: code, duplicate: true, status: 'pending' })
    await request.post(`/api/v1/agents/${AGENT_CODE}/logs`, { headers: auth, data: {
      level: 'warning', event: 'limit.exceeded', request: code, message: `£2,000,000 is above my £250,000 limit; asked for approval (${stamp})`,
    } })

    // 4. It appears on Ravi's open list without a reload, marked New, needing two approvers.
    const card = page.getByTestId('request-card').filter({ hasText: stamp })
    await expect(card).toBeVisible({ timeout: 10_000 })
    const appeared = (await cardSeenAt(page, stamp))! - raisedAt
    timings.push(`appeared ${appeared} ms`)
    expect(reloaded, 'the list must update without a page load').toBe(false)
    await expect(card.getByText('New', { exact: true })).toBeVisible()
    await expect(card.getByTestId('four-eyes')).toHaveText(/Four-eyes · 0 of 2/)

    // 5. Ravi reads it: what, how much, why, why it needs a person, by when, and who was told.
    await card.click()
    await expect(page.getByTestId('request-headline')).toHaveText(`${AGENT} wants to release £2,000,000 to supplier ${supplier}`)
    await expect(page.getByText('£2,000,000', { exact: true })).toBeVisible()
    await expect(page.getByText(/Invoice HS-48817 for the Q4 steel order is due today/)).toBeVisible()
    await expect(page.getByText(/outside its limits/)).toBeVisible()
    await expect(page.getByText(/Assigned to/)).toContainText('Ravi Menon')
    await expect(page.getByTestId('request-due')).toContainText('Decide within')
    await expect(page.getByTestId('four-eyes-status')).toContainText('two different approvers must approve (0 of 2 so far)')
    const told = page.getByTestId('who-was-told').locator('li')
    await expect(told.filter({ hasText: 'Email to Ravi Menon' })).toContainText('Not sent: test request')
    await expect(told.filter({ hasText: 'Phone alert to Ravi Menon' })).toHaveCount(1)

    // 6. Ravi approves first. The agent is still told to wait.
    await page.getByRole('button', { name: 'Approve' }).click()
    await page.getByLabel('Note (optional)').fill('Invoice and PO checked')
    await page.getByRole('button', { name: 'Confirm approval' }).click()
    await expect(page.getByTestId('four-eyes-status')).toContainText('1 of 2 so far')
    await expect(page.getByText('You have approved it. A second approver must decide.')).toBeVisible()
    const half = await (await request.get(`/api/v1/actions/${code}`, { headers: auth })).json()
    expect(half).toMatchObject({ status: 'pending', may_proceed: false, reason: 'Approved by Ravi Menon (1 of 2). Waiting for a second approver.' })

    // 7. Daniel, in his own browser (a phone too, in the phone run), sees it needs his approval and gives it.
    const { defaultBrowserType, ...pixel } = devices['Pixel 7']
    void defaultBrowserType // a browser choice, not a context option
    const daniel = await (await browser.newContext({ ...(info.project.name === 'phone' ? pixel : {}), baseURL })).newPage()
    try {
      await signIn(daniel, 'daniel.okafor')
      await daniel.getByRole('link', { name: 'Approvals' }).first().click()
      const his = daniel.getByTestId('request-card').filter({ hasText: stamp })
      await expect(his.getByTestId('four-eyes')).toHaveText(/Four-eyes · 1 of 2/)
      await his.click()
      await expect(daniel.getByTestId('four-eyes-status')).toContainText('Approved by Ravi Menon: Invoice and PO checked')
      await daniel.getByRole('button', { name: 'Approve' }).click()
      await daniel.getByLabel('Note (optional)').fill('Supplier verified')
      const decidedAt = Date.now()
      await daniel.getByRole('button', { name: 'Confirm approval' }).click()
      await expect(daniel.getByTestId('request-outcome')).toHaveText('Approved by Ravi Menon (Invoice and PO checked) and Daniel Okafor (Supplier verified)')

      // 8. The agent asks for the decision: it may go ahead. It goes ahead (simulated) and logs it against the request.
      let answer: Record<string, unknown> = {}
      await expect.poll(async () => {
        answer = await (await request.get(`/api/v1/actions/${code}`, { headers: auth })).json()
        return answer.status
      }, { timeout: 15_000, intervals: [250] }).toBe('approved')
      timings.push(`agent told ${Date.now() - decidedAt} ms after the second approval`)
      expect(answer).toMatchObject({ may_proceed: true, decision_source: 'human',
        reason: 'Approved by Ravi Menon (Invoice and PO checked) and Daniel Okafor (Supplier verified)' })
      const released = await request.post(`/api/v1/agents/${AGENT_CODE}/logs`, { headers: auth, data: {
        level: 'info', event: 'payment.released', request: code, message: `Released £2,000,000 to ${supplier} (simulated)`,
      } })
      expect(released.status()).toBe(201)
    } finally {
      await daniel.context().close()
    }

    // 9. On record. Ravi's list no longer shows it (live, no reload).
    await page.getByRole('link', { name: 'Approvals' }).first().click()
    await expect(page.getByTestId('request-card').filter({ hasText: stamp })).toHaveCount(0)
    // The request page shows the outcome; the agent's page shows its log, linked to the request.
    await page.goto('/agents')
    await page.getByLabel('Search agents').fill(AGENT)
    await page.getByRole('link', { name: AGENT }).first().click()
    await expect(page.getByTestId('last-heard')).toContainText('log entry')
    const log = page.getByTestId('log-entry')
    await expect(log.filter({ hasText: `Released £2,000,000 to ${supplier} (simulated)` })).toContainText(code)
    await expect(log.filter({ hasText: `asked for approval (${stamp})` })).toContainText(code)
    await expect(log.filter({ hasText: `matches purchase order PO-2026-0912` }).filter({ hasText: supplier })).toContainText('invoice.matched')
    await log.filter({ hasText: `Released £2,000,000 to ${supplier}` }).getByRole('link', { name: code }).click()
    await expect(page.getByTestId('request-outcome')).toHaveText('Approved by Ravi Menon (Invoice and PO checked) and Daniel Okafor (Supplier verified)')

    console.log(`[${info.project.name}] £2m story: ${timings.join(', ')}`)
    info.annotations.push({ type: '£2m story', description: timings.join(', ') })
  })
