import { expect, test } from '@playwright/test'

// Task 5.5 (added 13 Nov): retiring an agent also blocks it on its platform. Done when: a retired Appian agent reads back
// as blocked. The e2e workflow links a fresh registry agent to NAP-006 on the Appian simulator for each run (retiring is
// final), and afterwards checks in Appian itself that NAP-006 is quarantined, then switches it back on.
// Desktop only: one agent, retired once.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const CODE = process.env.ACT_RETIRE_AGENT_CODE ?? ''

test('retiring an Appian agent blocks it there, read back as blocked', async ({ page }, info) => {
  test.skip(!PASSWORD || !CODE, 'DEMO_USER_PASSWORD and ACT_RETIRE_AGENT_CODE are set by the e2e workflow')
  test.skip(info.project.name !== 'desktop', 'One agent, retired once')
  test.setTimeout(120_000)
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  await page.getByPlaceholder(/Search/).fill(CODE)
  await page.getByRole('link', { name: new RegExp(`^${CODE} `) }).first().click()
  await expect(page.getByText('On an agent platform')).toBeVisible()

  await page.getByRole('button', { name: 'Retire', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('blocked there too')
  await page.getByRole('dialog').getByLabel('Reason').fill('Replaced by the new forecasting service (retire test)')
  const retired = Date.now()
  await page.getByRole('dialog').getByRole('button', { name: 'Retire agent' }).click()
  const step = page.getByTestId('retire-step').first()
  await expect(step).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await expect(step).toHaveText(/^Blocked on Northbridge Agent Platform \(simulated\) as NAP-006; read back as blocked/)
  const took = Date.now() - retired
  console.log(`[retire] ${CODE} retired; blocked on Appian as NAP-006 and read back ${took} ms later`)
})
