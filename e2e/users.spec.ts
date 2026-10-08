import { expect, test, type Page } from '@playwright/test'

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test('an admin adds a person, they choose their own password, and deactivation locks them out', async ({ page }) => {
  const stamp = Date.now()
  const email = `e2e.user.${stamp}@northbridge.demo`
  const name = `E2E Person ${stamp}`

  // The admin adds the person.
  await signIn(page, 'admin@northbridge.demo', PASSWORD)
  await page.getByRole('link', { name: 'Users' }).first().click()
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
  await expect(page.getByText('Daniel Okafor').filter({ visible: true }).first()).toBeVisible()
  await page.getByRole('link', { name: 'Add person' }).click()
  await page.getByLabel('Full name').fill(name)
  await page.getByLabel('Work email').fill(email)
  // An approver needs at least one department.
  await page.getByLabel(/^Approver/).check()
  await page.getByRole('button', { name: 'Add person' }).click()
  await expect(page.getByText('Choose at least one department')).toBeVisible()
  await page.getByLabel('Payments', { exact: true }).check()
  await page.getByRole('button', { name: 'Add person' }).click()

  await expect(page.getByRole('heading', { name: `${name} has been added` })).toBeVisible()
  const temporary = (await page.getByTestId('temporary-password').textContent())?.trim() ?? ''
  expect(temporary).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/)
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
  await expect(page.getByText('Yet to sign in').first()).toBeVisible()
  await signOut(page)

  // The person signs in with the temporary password and must choose their own.
  await signIn(page, email, temporary)
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible()
  await page.getByLabel('New password').fill(temporary)
  await page.getByLabel('Type it again').fill(temporary)
  await page.getByRole('button', { name: 'Save new password' }).click()
  await expect(page.getByText(/at least 12 characters|not the temporary one/)).toBeVisible()
  const own = `e2e-own-password-${stamp}`
  await page.getByLabel('New password').fill(own)
  await page.getByLabel('Type it again').fill(own)
  await page.getByRole('button', { name: 'Save new password' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  // As a Payments approver they see the Approvals page.
  await expect(page.getByRole('link', { name: 'Approvals' }).first()).toBeVisible()
  await signOut(page)

  // The admin deactivates them.
  await signIn(page, 'admin@northbridge.demo', PASSWORD)
  await page.getByRole('link', { name: 'Users' }).first().click()
  await page.getByLabel('Search users').fill(email)
  await page.getByRole('link', { name }).filter({ visible: true }).first().click()
  await expect(page.getByText('Active', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Deactivate' }).click()
  await page.getByLabel(/Reason/).fill('End-to-end test finished')
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click()
  await expect(page.getByRole('button', { name: 'Reactivate' })).toBeVisible()
  await signOut(page)

  // They can no longer sign in.
  await signIn(page, email, own)
  await expect(page.getByText('This account has been deactivated')).toBeVisible()
})

test('people who are not admins cannot open the Users page', async ({ page }) => {
  await signIn(page, 'priya.sharma@northbridge.demo', PASSWORD)
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0)
  await page.goto('/users')
  await expect(page.getByText('Only admins can open this page.')).toBeVisible()
})
