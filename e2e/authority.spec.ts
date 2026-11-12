import { expect, test } from '@playwright/test'

// Task 4.8: the data-authority matrix. Sales Lead Summariser (NAP-003 on the Appian simulator) handles personal data and
// is shared with Ana Costa, a Sales Associate; that role is not authorised for personal data, so she is flagged. An
// admin allows it in the matrix: the flag clears at once; taking the tick away brings it back (and leaves the matrix as found).
// Desktop only: the matrix is shared, and two browsers changing it at once would trip each other up.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

test('someone without authority for an agent\'s data is flagged, and the matrix decides', async ({ page }, info) => {
  test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
  test.skip(info.project.name !== 'desktop', 'The matrix is shared; one browser changes it')
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()

  const allow = async (on: boolean) => {
    await page.goto('/users')
    const box = page.getByTestId('authority-matrix').getByLabel('Sales Associate may see Personal data', { exact: true })
    await expect(box).toBeEnabled()
    if ((await box.isChecked()) !== on) await box.click()
    await expect(box).toBeChecked({ checked: on })
    await expect(box).toBeEnabled() // saved
  }
  await allow(false)
  const ana = page.getByTestId('authority-finding').filter({ hasText: 'Ana Costa' })
  await expect(ana).toContainText('Sales Lead Summariser')
  await expect(ana).toContainText('not authorised for Personal data')

  // On the agent's page: flagged, with the alert.
  await ana.getByRole('link').click()
  const person = page.getByTestId('access-person').filter({ hasText: 'Ana Costa' })
  await expect(person).toContainText('Sales Associate')
  await expect(person.getByTestId('access-missing')).toHaveText('Not authorised for Personal data')
  await expect(page.getByTestId('alert-data_authority')).toContainText('Ana Costa (Sales Associate) for Personal')
  const agentUrl = page.url()

  try {
    await allow(true)
    await expect(page.getByTestId('authority-finding').filter({ hasText: 'Ana Costa' })).toHaveCount(0)
    await page.goto(agentUrl)
    await expect(page.getByTestId('access-person').filter({ hasText: 'Ana Costa' })).toContainText('Authorised')
    await expect(page.getByTestId('alert-data_authority')).toHaveCount(0)
  } finally {
    await allow(false)
  }
  await page.goto(agentUrl)
  await expect(page.getByTestId('access-person').filter({ hasText: 'Ana Costa' }).getByTestId('access-missing')).toBeVisible()
  console.log('[authority] Ana Costa (Sales Associate) flagged on Sales Lead Summariser; cleared and restored through the matrix')
})
