import { expect, test } from '@playwright/test'

// Task 5.2: alert routing. Done when: changing a route needs no deploy. An admin adds a route on the screen for the
// Payments department ("Suspended" alerts to Daniel Okafor only); "Test an alert" shows the change at once for a
// Payments agent, other alerts still follow the default route; deleting the route puts it back.
// Desktop only: routes are shared, and two browsers changing them at once would trip each other up.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

test('an admin changes who gets an alert on the screen, and the next alert follows it', async ({ page }, info) => {
  test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
  test.skip(info.project.name !== 'desktop', 'Routes are shared; one browser changes them')
  const name = `E2E route ${Date.now()}`
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  await page.getByRole('link', { name: 'Alerts' }).click()
  await expect(page.getByRole('heading', { name: 'Alert routing' })).toBeVisible()
  await expect(page.locator('[data-testid="alert-route"][data-scope="default"]')).toContainText('Every admin, the business owner')

  const tryAlert = async (alert: string) => {
    await page.getByLabel('Agent', { exact: true }).selectOption({ label: (await page.getByLabel('Agent', { exact: true }).locator('option', { hasText: 'Invoice Matcher' }).first().textContent())! })
    await page.getByLabel('Alert', { exact: true }).selectOption({ label: alert })
    await page.getByRole('button', { name: 'Test', exact: true }).click()
    return page.getByTestId('alert-route-result')
  }
  // Before: the default route (every admin and the business owner, James Whitfield).
  await expect(await tryAlert('Suspended')).toContainText('James Whitfield')
  await expect(page.getByTestId('alert-route-result')).not.toContainText('Daniel Okafor')

  // An admin adds a route for Payments: "Suspended" alerts go to Daniel Okafor only.
  await page.getByRole('button', { name: 'Add route' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Route name').fill(name)
  await dialog.getByLabel('Department').selectOption({ label: 'Payments' })
  await dialog.getByLabel('All alerts').uncheck() // leaves "Suspended" ticked
  await dialog.getByLabel("The agent's business owner").uncheck()
  await dialog.getByLabel('Also everyone on the default route').uncheck()
  await dialog.getByTestId('alert-route-people').getByLabel('Daniel Okafor', { exact: true }).check()
  await dialog.getByTestId('save-alert-route').click()
  await expect(page.getByRole('status')).toHaveText('Saved. The next alert follows it.')
  await expect(page.getByTestId('alert-route').filter({ hasText: name })).toContainText('Department: Payments · Suspended')

  // At once, with no deploy: Suspended goes to Daniel only; other alerts still follow the default route.
  const after = await tryAlert('Suspended')
  await expect(after.getByTestId('alert-route-person')).toHaveCount(1)
  await expect(after).toContainText(`Daniel Okafor`)
  await expect(after).toContainText(`route "${name}"`)
  await expect(await tryAlert('Switched back on')).toContainText('James Whitfield')

  // Deleted: back to the default route.
  await page.getByRole('button', { name: `Delete ${name}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('status')).toHaveText(`Deleted "${name}".`)
  await expect(await tryAlert('Suspended')).toContainText('James Whitfield')
  console.log(`[alert-routing] ${name}: Suspended for Payments went to Daniel Okafor only, then back to the default route`)
})
