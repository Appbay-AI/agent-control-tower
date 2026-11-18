import { expect, test, type Page } from '@playwright/test'

// Task 6.4: the risk dashboard. Done when: the figures match the data. Priya Sharma (executive) opens it; its agent
// totals are checked against the registry, each department's tiers add up to its agents, and the agent with the most
// incidents has exactly that many on its own page. Other tests run at the same time and add incidents, so each
// comparison is retried until both sides are read at a quiet moment.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const num = async (page: Page, testId: string) => Number(await page.getByTestId(testId).first().textContent())

test('the risk dashboard\'s figures match the registry and the agents\' own incident lists', async ({ page }, info) => {
  test.skip(!PASSWORD || info.project.name !== 'desktop', 'desktop menu only; DEMO_USER_PASSWORD is set by the e2e workflow')
  test.setTimeout(150_000)
  await page.goto('/login')
  await page.getByLabel('Email').fill('priya.sharma@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()

  // 1. Active agents: the heat map's total equals the registry's count.
  let agents = 0
  await expect(async () => {
    await page.goto('/agents')
    const registry = Number((await page.getByText(/^\d+ active agents$/).textContent({ timeout: 15_000 }))?.split(' ')[0])
    const started = Date.now()
    await page.goto('/risk')
    await expect(page.getByTestId('risk')).toBeVisible({ timeout: 15_000 })
    info.annotations.push({ type: 'load', description: String(Date.now() - started) })
    agents = Number(await page.getByTestId('heat-total').locator('td').nth(4).textContent())
    expect(agents).toBe(registry)
  }).toPass({ timeout: 60_000 })

  // 2. Each department's four tiers add up to its agents, and the departments add up to the total.
  const rows = page.getByTestId('heat-row')
  let sum = 0
  for (let i = 0; i < (await rows.count()); i++) {
    const cells = (await rows.nth(i).locator('td').allTextContents()).map(Number)
    expect(cells[0] + cells[1] + cells[2] + cells[3], `row ${i}`).toBe(cells[4])
    sum += cells[4]
  }
  expect(sum).toBe(agents)

  // 3. The agent with the most incidents has that many incidents on its own page (all are within 90 days on this site).
  let top = ''
  let count = 0
  await expect(async () => {
    await page.goto('/risk')
    const first = page.getByTestId('top-agent').first()
    top = (await first.getByRole('link').textContent()) ?? ''
    count = await num(page, 'top-incidents')
    await first.getByRole('link').click()
    await expect(page.getByTestId('incident-list')).toBeVisible({ timeout: 15_000 })
    expect(await page.getByTestId('incident-row').count()).toBe(count)
  }).toPass({ timeout: 60_000 })

  const breaches = await page.goto('/risk').then(() => page.getByRole('region', { name: 'Breaches, week by week' }).getByText(/^\d+ in 90 days/).textContent())
  console.log(`[risk] ${agents} active agents as in the registry; top agent ${top} with ${count} incidents as on its page; ${breaches?.split(':')[0]} breaches`)
})
