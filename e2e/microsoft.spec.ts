import { expect, test } from '@playwright/test'

// Task 3.1 (resumed): Microsoft sends the browser back to /api/v1/microsoft/callback as a page visit. It must reach our
// server even when the installed app (service worker) is in control, and the person lands on Integrations with the
// outcome. Here Microsoft "refuses" (no real Microsoft sign-in in tests).

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

test('the return from Microsoft reaches our server and shows the outcome on the Integrations page', async ({ page }) => {
  test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  // Let the app's service worker take control, as it does for a real person.
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 15_000 }).catch(() => undefined)

  await page.goto('/api/v1/microsoft/callback?error=access_denied&error_description=Test%20refusal&state=x')
  await expect(page).toHaveURL(/\/integrations\?microsoft=error/)
  await expect(page.getByTestId('microsoft-outcome')).toContainText('Microsoft was not connected. Microsoft said: Test refusal')
  await expect(page.getByTestId('microsoft-connect')).toBeVisible()
})
