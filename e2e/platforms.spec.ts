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

// Task 3.3: Sync now fetches the simulator's agents, and they are listed on the registry page. Read-only in Appian.
test('an admin syncs the Appian simulator and its agents are listed on the registry page', async ({ page }) => {
  test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()

  await page.goto('/integrations')
  const row = page.getByTestId('platform-connection').filter({ hasText: 'Northbridge Agent Platform (simulated)' })
  await expect(row.getByTestId('sync-every')).toHaveText(/^(Synced every|Automatic sync off)/)
  await row.getByRole('button', { name: 'Sync now' }).click()
  await expect(row.getByTestId('platform-sync'))
    .toContainText(/Synced \d+ agents from Northbridge Agent Platform \(simulated\)/, { timeout: 45_000 })
  console.log(`[platforms] ${await row.getByTestId('platform-sync').textContent()}`)

  await page.goto('/agents')
  const found = page.getByTestId('platform-agents')
  await expect(found.getByRole('heading', { name: 'Found on agent platforms' })).toBeVisible()
  await expect(found.getByTestId('platform-agent').filter({ hasText: 'NAP-001' })).toContainText('Refund Processor')
  await expect(found.getByTestId('platform-agent').filter({ hasText: 'NAP-004' })).toContainText('No owner')
  await expect(found.getByTestId('platform-agent').filter({ hasText: 'NAP-007' })).toContainText(/Blocked on platform|Active on platform/)

  // Task 3.5: each is in the registry. NAP-004 has no owner, so nobody can submit it: it stays Discovered, with an alert.
  const rota = found.getByTestId('platform-agent').filter({ hasText: 'NAP-004' }).getByTestId('platform-agent-registry')
  await expect(rota).toContainText(/AGT-\d{4}/)
  await expect(rota).toContainText(/Discovered|Retired/)
  if ((await rota.textContent())?.includes('Discovered')) {
    await rota.click()
    await expect(page.getByTestId('platform-record')).toContainText('NAP-004')
    await expect(page.getByTestId('platform-record')).toContainText('Northbridge Agent Platform (simulated)')
    await expect(page.getByTestId('alert-agent_discovered')).toContainText('was found on Northbridge Agent Platform (simulated) as NAP-004 and is not registered')
    await expect(page.getByRole('button', { name: 'Put live' })).toHaveCount(0)
  }
})
