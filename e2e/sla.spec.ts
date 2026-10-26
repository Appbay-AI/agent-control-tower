import { expect, test, type Page } from '@playwright/test'

// Task 2.9: time limits, in real time. An admin adds a rule: 1 minute to decide, then escalate once to Daniel.
// The agent asks; nobody decides; the clock (pg_cron, every minute) moves it to Daniel; nobody decides again; it
// expires and the agent is told no. Takes about 4 minutes. The amount band matches only this test's request.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const AGENT_KEY = process.env.ACT_AGENT_KEY ?? ''

async function signIn(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

async function optionValue(page: Page, select: string, text: string) {
  return (await page.locator(`${select} option`, { hasText: text }).first().getAttribute('value'))!
}

test('nobody decides in time: escalated once to the next approver, then it expires and the agent is told no', async ({ page, request }) => {
  test.skip(!AGENT_KEY, 'ACT_AGENT_KEY is set by the e2e workflow')
  test.setTimeout(7 * 60_000)
  const stamp = `E2E ${Date.now()}`
  const ruleName = `E2E rule ${stamp}`

  // The admin adds the rule on the Routing screen.
  await signIn(page, 'admin')
  await page.goto('/routing')
  await page.getByRole('button', { name: 'Add rule' }).click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Rule name', { exact: true }).fill(ruleName)
  await form.getByLabel('Amount from', { exact: true }).fill('1234567')
  await form.getByLabel('Up to (not including)', { exact: true }).fill('1234568')
  await form.getByLabel('Priority (lower is checked first)', { exact: true }).fill('1')
  await form.getByLabel('Approved by', { exact: true }).selectOption(await optionValue(page, '#r-approver', 'Ravi Menon'))
  await form.getByLabel('Minutes', { exact: true }).fill('1')
  await form.getByLabel('If nobody decides in time', { exact: true }).selectOption('escalate')
  await form.getByLabel('Escalate to', { exact: true }).selectOption(await optionValue(page, '#r-escalate-to', 'Daniel Okafor'))
  await form.getByRole('button', { name: 'Save rule' }).click()
  const ruleRow = page.getByRole('listitem').filter({ hasText: ruleName })
  await expect(ruleRow).toContainText('Within 1 minute, else escalated once to Daniel Okafor')

  try {
    // The agent asks.
    const asked = await request.post('/api/v1/actions/request', {
      headers: { authorization: `Bearer ${AGENT_KEY}`, 'idempotency-key': stamp },
      data: { action: 'payment.release', amount: 1234567, currency: 'GBP', description: `Release £1,234,567 to supplier ${stamp}`,
        reasoning: 'Time limit test', details: { test: true } },
    })
    expect(asked.status()).toBe(201)
    const { request_id: id, request_code: code, status } = await asked.json()
    expect(status).toBe('pending')

    // The request page shows the clock and what happens next.
    await page.goto(`/approvals/requests/${id}`)
    await expect(page.getByText(/Assigned to/)).toContainText('Ravi Menon')
    await expect(page.getByTestId('request-due')).toContainText('then it goes to Daniel Okafor')

    // Nobody decides: within about two minutes it moves to Daniel, automatically.
    await expect.poll(async () => {
      await page.reload()
      return (await page.getByText(/Assigned to/).first().textContent().catch(() => '')) ?? ''
    }, { timeout: 150_000, intervals: [10_000] }).toContain('Daniel Okafor')
    await expect(page.getByText(/automatically: No decision within 1 minute, so it was escalated automatically/)).toBeVisible()
    await expect(page.getByTestId('request-due')).toContainText('then it expires and the agent is told no')

    // Nobody decides again: it expires.
    await expect.poll(async () => {
      await page.reload()
      return (await page.getByTestId('request-outcome').textContent().catch(() => '')) ?? ''
    }, { timeout: 150_000, intervals: [10_000] }).toBe('No decision within 1 minute, so it was not allowed. The agent must not proceed.')
    await expect(page.getByText('Expired: nobody decided in time')).toBeVisible()

    const answer = await (await request.get(`/api/v1/actions/${code}`, { headers: { authorization: `Bearer ${AGENT_KEY}` } })).json()
    expect(answer).toMatchObject({ status: 'expired', may_proceed: false, decision_source: 'timeout' })
  } finally {
    // Tidy up: delete the rule (this also checks a rule can be deleted after it routed a decided request).
    await page.goto('/routing')
    await page.getByRole('button', { name: `Delete ${ruleName}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByRole('button', { name: `Delete ${ruleName}` })).toHaveCount(0)
  }
})
