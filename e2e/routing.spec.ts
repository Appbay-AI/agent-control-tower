import { expect, test, type Page } from '@playwright/test'

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

async function signInAsAdmin(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

async function testRoute(page: Page, amount: string) {
  await page.getByLabel('Agent', { exact: true }).selectOption({ label: 'AGT-0001 Payment Release Assistant' })
  await page.getByLabel('Amount').fill(amount)
  await page.getByRole('button', { name: 'Test' }).click()
  return page.getByTestId('routing-result')
}

test.describe.configure({ mode: 'serial' })

test('an admin changes who approves a request, with no code and no release', async ({ page }) => {
  const name = `E2E rule ${Date.now()}`
  await signInAsAdmin(page)
  await page.getByRole('link', { name: 'Routing' }).first().click()
  await expect(page.getByRole('heading', { name: 'Approval routing' })).toBeVisible()
  await expect(page.getByText('Large payments (£1m and above)')).toBeVisible()

  // The demo rule sends the £2m payment to Ravi.
  await expect(await testRoute(page, '2000000')).toContainText('Ravi Menon approves')

  // A new top rule for Payments sends it to Daniel instead.
  await page.getByRole('button', { name: 'Add rule' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Rule name').fill(name)
  await dialog.getByLabel('Department').selectOption({ label: 'Payments' })
  await dialog.getByLabel('Amount from').fill('1000')
  await dialog.getByLabel('Priority (lower is checked first)').fill('1')
  await dialog.getByLabel('Approved by').selectOption({ label: 'Daniel Okafor · Payments Risk Lead' })
  await dialog.getByRole('button', { name: 'Save rule' }).click()
  await expect(page.getByRole('button', { name: `Delete ${name}` })).toBeVisible()
  await expect(await testRoute(page, '2000000')).toContainText('Daniel Okafor approves')

  // Removing it restores the previous routing.
  await page.getByRole('button', { name: `Delete ${name}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('button', { name: `Delete ${name}` })).toHaveCount(0)
  await expect(await testRoute(page, '2000000')).toContainText('Ravi Menon approves')
})
