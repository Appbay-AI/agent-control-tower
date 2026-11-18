import { expect, test } from '@playwright/test'

// Task 6.6 (R5.1, R5.2): the drift report and sync health. Done when: the reports match the records. Mei Lin (auditor)
// opens Drift and sync: the agent with the most changes outside the Control Tower has exactly that many on its own
// page, and the agents a platform lists (sync health) are the ones the registry's "Found on agent platforms" shows.
// Other tests change agents on Appian at the same time, so each comparison is retried until both sides agree.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

test('the drift report and sync health match the records', async ({ page }, info) => {
  test.skip(!PASSWORD || info.project.name !== 'desktop', 'desktop menu only; DEMO_USER_PASSWORD is set by the e2e workflow')
  test.setTimeout(150_000)
  await page.goto('/login')
  await page.getByLabel('Email').fill('mei.lin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  await page.getByRole('link', { name: 'Reports' }).click()
  await page.getByRole('link', { name: /^Drift and sync/ }).click()
  await expect(page.getByTestId('drift-report')).toBeVisible()

  // 1. Drift: the total equals the rows listed, and the agent changed most has that many changes on its own page.
  let agent = ''
  let changes = 0
  await expect(async () => {
    await page.goto('/drift-sync')
    const total = Number(await page.getByTestId('drift-total').textContent({ timeout: 15_000 }))
    expect(total).toBeGreaterThan(0)
    if (total <= 2000) await expect(page.getByTestId('drift-row')).toHaveCount(total)
    const top = page.getByRole('region', { name: 'Drift summary' }).getByRole('link').first()
    agent = (await top.textContent()) ?? ''
    changes = Number(await top.locator('xpath=following-sibling::span').textContent())
    // The report filtered to that agent lists the same number.
    await page.getByLabel('Agent').fill(agent.split(' ')[0])
    await expect(page.getByTestId('drift-row')).toHaveCount(changes)
    await top.click()
    await expect(page.getByTestId('drift-list')).toBeVisible({ timeout: 15_000 })
    expect(await page.getByTestId('drift-event').count()).toBe(changes)
  }).toPass({ timeout: 90_000 })

  // 2. Sync health: agents listed now equals the platform agents the registry shows (none missing).
  let listed = 0
  await expect(async () => {
    await page.goto('/drift-sync?tab=sync')
    const fact = page.getByTestId('fact-agents').first()
    listed = Number(await fact.locator('dd').first().textContent({ timeout: 15_000 }))
    await expect(page.getByTestId('health-state').first()).toHaveAttribute('data-state', /healthy|failing|overdue|off/)
    await page.goto('/agents')
    const shown = (await page.getByTestId('platform-agents').locator('p').first().textContent({ timeout: 15_000 })) ?? ''
    const [all, missing] = [Number(shown.match(/^(\d+) listed/)?.[1]), Number(shown.match(/(\d+) missing at source/)?.[1] ?? 0)]
    expect(all - missing).toBe(listed)
  }).toPass({ timeout: 90_000 })

  await page.goto('/drift-sync?tab=sync')
  const state = await page.getByTestId('health-state').first().textContent()
  console.log(`[drift-sync] top drift agent ${agent} with ${changes} changes as on its page; ${listed} agents listed as in the registry; sync: ${state}`)
})
