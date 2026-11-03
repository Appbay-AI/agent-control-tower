import { expect, test } from '@playwright/test'

// Task 4.2: enforcement by source. Suspending an agent that lives on the Appian simulator blocks it there through our
// API, and the agent's page shows it confirmed (read back as blocked). The e2e workflow makes the test agent (linked to
// NAP-001) Live on the work-in-progress database, and switches NAP-001 back on and the agent back to Live afterwards.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const CODE = process.env.ACT_PLATFORM_AGENT_CODE ?? ''

test('suspending an agent that lives on Appian blocks it there, confirmed by reading it back', async ({ page }, info) => {
  test.skip(!PASSWORD || !CODE, 'DEMO_USER_PASSWORD and ACT_PLATFORM_AGENT_CODE are set by the e2e workflow')
  test.setTimeout(2 * 60_000)
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  await page.getByLabel('Search agents').fill(CODE)
  await page.getByRole('link', { name: 'Refund Processor' }).first().click()
  await expect(page.getByTestId('agent-code')).toHaveText(CODE)
  await expect(page.getByTestId('platform-record')).toContainText('NAP-001')

  await page.getByTestId('suspend-button').click()
  await page.getByRole('dialog').getByLabel('Reason').fill(`E2E enforcement ${Date.now()}`)
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
})
