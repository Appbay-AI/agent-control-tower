import { expect, test } from '@playwright/test'

// Task 3.2: the admin tests the connection to the Appian agent-platform simulator. Our site, not the browser, talks to
// Appian with the key kept in the database, and the page shows what it found. Read-only: nothing changes in Appian.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

test('an admin tests the connection to the Appian simulator and sees how many agents it found', async ({ page }) => {
  test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()

  await page.goto('/integrations')
  const row = page.getByTestId('platform-connection').filter({ hasText: 'Northbridge Agent Platform (simulated)' })
  await expect(row).toContainText('https://appbay-demo.appiancloud.com')
  await expect(row).toContainText('API key stored')
  await row.getByRole('button', { name: 'Test connection' }).click()
  await expect(row.getByTestId('platform-check'))
    .toContainText(/Connected to Northbridge Agent Platform \(simulated\): \d+ agents found/, { timeout: 45_000 })
  console.log(`[platforms] ${await row.getByTestId('platform-check').textContent()}`)
})
