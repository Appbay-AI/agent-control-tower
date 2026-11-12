import { expect, test, type Page } from '@playwright/test'

// Task 4.2: enforcement by source. Suspending an agent that lives on the Appian simulator blocks it there through our
// API, and the agent's page shows it confirmed (read back as blocked). The e2e workflow makes the test agent (linked to
// NAP-001) Live on the work-in-progress database, and switches NAP-001 back on and the agent back to Live afterwards.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const CODE = process.env.ACT_PLATFORM_AGENT_CODE ?? ''

async function signIn(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

test('suspending an agent that lives on Appian blocks it there; it comes back only through approval, unblocked there', async ({ page, browser, baseURL }, info) => {
  test.skip(!PASSWORD || !CODE, 'DEMO_USER_PASSWORD and ACT_PLATFORM_AGENT_CODE are set by the e2e workflow')
  test.setTimeout(4 * 60_000)
  await signIn(page, 'admin')
  await page.getByLabel('Search agents').fill(CODE)
  await page.getByRole('link', { name: 'Refund Processor' }).first().click()
  await expect(page.getByTestId('agent-code')).toHaveText(CODE)
  await expect(page.getByTestId('platform-record')).toContainText('NAP-001')

  await page.getByTestId('suspend-button').click()
  const reason = `E2E enforcement ${Date.now()}`
  await page.getByRole('dialog').getByLabel('Reason').fill(reason)
  const pressed = Date.now()
  await page.getByRole('button', { name: 'Suspend now' }).click()

  const step = page.getByTestId('enforcement-platform')
  await expect(step).toContainText('Blocked on Northbridge Agent Platform (simulated) as NAP-001; read back as blocked', { timeout: 60_000 })
  await expect(step).toContainText('Done')
  const took = Date.now() - pressed
  console.log(`[enforcement] blocked in Appian and read back ${took} ms after Suspend now`)
  info.annotations.push({ type: 'enforcement', description: `${took} ms` })
  // The page shows the platform's own record as blocked too.
  await page.reload()
  await expect(page.getByTestId('platform-record')).toContainText('Blocked on the platform')

  // Task 4.6: it comes back only through approval. The suspension opened an incident; it must be Contained first.
  await expect(page.getByTestId('ask-reactivation')).toBeDisabled()
  await page.getByTestId('incident-row').filter({ hasText: reason }).getByTestId('incident-link').click()
  await page.getByLabel('Containment').fill('Agent suspended and blocked in Appian')
  await page.getByTestId('save-case').click()
  await expect(page.getByTestId('incident-log')).toContainText('Updated Containment')
  await page.getByTestId('mark-contained').click()
  await page.getByTestId('confirm-action').click()
  await expect(page.getByRole('button', { name: 'Back to open' })).toBeVisible()
  await page.getByRole('link', { name: new RegExp(`^${CODE} Refund Processor$`) }).click()

  // Task 4.9: the test agent has had incidents on earlier runs; repeats force a review before it can be asked back on.
  await expect(page.getByTestId('ask-reactivation')).toBeVisible()
  if (await page.getByTestId('reactivation-review-first').isVisible()) {
    await expect(page.getByTestId('ask-reactivation')).toBeDisabled()
    await page.getByRole('button', { name: 'Record review' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Save review' }).click()
    await expect(page.getByTestId('reactivation-review-first')).toHaveCount(0)
    console.log('[reactivation] review required first (repeat incidents); recorded')
  }

  await page.getByTestId('ask-reactivation').click()
  await page.getByRole('dialog').getByLabel('Reason').fill('Refund rules fixed and tested')
  await page.getByTestId('reactivation-confirm').click()
  await expect(page.getByTestId('reactivation-waiting')).toContainText('Refund rules fixed and tested')
  await expect(page.getByTestId('approve-reactivation')).toHaveCount(0) // the asker cannot approve
  await expect(page.getByTestId('suspension-done')).toBeVisible()      // still suspended

  // Ravi Menon (approver for Customer Service) approves from his Approvals page, in another browser.
  const ravi = await (await browser.newContext({ baseURL })).newPage()
  await signIn(ravi, 'ravi.menon')
  await ravi.getByRole('link', { name: 'Approvals' }).first().click()
  await ravi.getByTestId('reactivation-requests').getByRole('link', { name: `${CODE} Refund Processor` }).click()
  await ravi.getByTestId('approve-reactivation').click()
  const approved = Date.now()
  await ravi.getByTestId('reactivation-confirm').click()
  const back = ravi.getByTestId('restore-platform')
  await expect(back).toContainText('Switched back on at Northbridge Agent Platform (simulated) as NAP-001; read back as active', { timeout: 60_000 })
  const took2 = Date.now() - approved
  console.log(`[reactivation] switched back on in Appian and read back ${took2} ms after approval`)
  await expect(ravi.getByTestId('reactivation-done')).toContainText('Approved by Ravi Menon')
  await expect(ravi.getByTestId('suspension-done')).toHaveCount(0)
  await ravi.close()
})
