import { expect, test } from '@playwright/test'

// Server addresses (/api/...) visited as a page must reach our server, even when the installed app (service worker)
// is in control: Microsoft's sign-in came back to /api/v1/microsoft/callback this way (task 3.1), and the cached app
// once answered it with "Page not found". Microsoft is switched off now (11 Nov), so the server answers 404 itself.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

test('a page visit to a server address reaches the server, not the cached app', async ({ page }) => {
  test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  // Let the app's service worker take control, as it does for a real person.
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 15_000 }).catch(() => undefined)

  const res = await page.goto('/api/v1/microsoft/callback?error=access_denied&state=x')
  expect(res?.status()).toBe(404)
  await expect(page.locator('body')).toContainText('Microsoft is switched off on this site.')

  // And the Integrations page no longer offers Connect Microsoft.
  await page.goto('/integrations')
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible()
  await expect(page.getByTestId('microsoft-connect')).toHaveCount(0)
})
