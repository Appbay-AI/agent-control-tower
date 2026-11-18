import { expect, test } from '@playwright/test'

// Task 6.3 (R5.3): the executive dashboard. Done when: it loads in under 3 seconds. Priya Sharma (executive) opens it
// from the menu on the work-in-progress site; its figures are checked against the registry, and a tile opens the
// registry with that filter on.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

test('the executive dashboard loads in under 3 seconds and agrees with the registry @phone', async ({ page }, info) => {
  test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
  await page.goto('/login')
  await page.getByLabel('Email').fill('priya.sharma@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  const registry = Number((await page.getByText(/^\d+ active agents$/).textContent())?.split(' ')[0])

  await page.getByRole('link', { name: 'Reports' }).last().click()
  const started = Date.now()
  await page.getByRole('link', { name: /^Executive dashboard/ }).click()
  await expect(page.getByTestId('dashboard')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Incidents opened, week by week' }).locator('.recharts-bar-rectangle').first()).toBeAttached()
  const took = Date.now() - started
  expect(took, 'dashboard load time (ms)').toBeLessThan(3000)

  // The figures: active agents as in the registry; every headline figure and chart present.
  const tiles = page.getByTestId('tile')
  await expect(tiles).toHaveCount(6)
  await expect(page.getByRole('link', { name: /^Active agents: \d+$/ })).toHaveAttribute('aria-label', `Active agents: ${registry}`)
  for (const t of ['Agents by risk tier', 'Where agents come from', 'Time to approve, week by week', 'Incidents opened, week by week']) {
    await expect(page.getByRole('region', { name: t })).toBeVisible()
  }
  await expect(page.getByTestId('coverage')).toContainText(/\d+% governed: agent platforms list \d+ agents/)
  const noOwner = Number((await page.getByRole('link', { name: /^Without an owner: \d+$/ }).getAttribute('aria-label'))?.split(': ')[1])

  // A tile opens the registry with its filter on.
  await page.getByRole('link', { name: /^Without an owner: / }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  const filter = page.getByRole('button', { name: /No owner/ }).first()
  await expect(filter).toHaveAttribute('aria-pressed', 'true')
  await expect(filter).toContainText(`${noOwner}No owner`)
  console.log(`[dashboard] ${info.project.name}: loaded ${took} ms after the click; ${registry} active agents, ${noOwner} without an owner, matching the registry`)
})
