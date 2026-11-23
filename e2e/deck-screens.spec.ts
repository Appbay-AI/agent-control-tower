import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

// Pictures for the user-journey deck (23 Nov). Opens pages and dialogs only: it never saves, approves or suspends,
// so it is safe on the client demo site. Each picture is one screen (not the full page) unless marked full.
const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const DIR = process.env.SCREENS_DIR ?? 'deck-screens'
test.skip(!PASSWORD || !process.env.DECK_SCREENS, 'run by the Deck screens workflow')

async function loaded(page: Page) {
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('main [aria-label="Loading"], main [data-slot="skeleton"]')).toHaveCount(0, { timeout: 20_000 })
  await page.waitForTimeout(800)
}
async function signIn(page: Page, who: string) {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* */ } })
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible({ timeout: 20_000 })
}
const done: string[] = []
const failed: string[] = []
async function shot(page: Page, name: string, go: () => Promise<void>, full = false) {
  try {
    await go()
    await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: full })
    done.push(name)
  } catch (e) { failed.push(`${name}: ${String(e).split('\n')[0]}`) }
}
async function openAgent(page: Page, name: string) {
  await page.goto('/agents')
  await loaded(page)
  await page.getByLabel('Search agents').fill(name)
  await page.getByRole('link', { name }).first().click()
  await loaded(page)
}

test('deck pictures, desktop', async ({ browser }) => {
  test.setTimeout(15 * 60_000)
  mkdirSync(DIR, { recursive: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()

  await shot(page, 'd01-login', async () => { await page.goto('/login'); await page.getByLabel('Email').waitFor() })

  await signIn(page, 'admin')
  await shot(page, 'd02-registry', async () => { await page.goto('/agents'); await loaded(page) })
  await shot(page, 'd02b-registry-full', async () => { await page.goto('/agents'); await loaded(page) }, true)
  await shot(page, 'd03-agent-pra', () => openAgent(page, 'Payment Release Assistant'))
  await shot(page, 'd03b-agent-pra-full', async () => {}, true)
  await shot(page, 'd04-agent-new', async () => { await page.goto('/agents/new'); await loaded(page) })
  await shot(page, 'd04b-agent-new-full', async () => {}, true)
  await shot(page, 'd05-fx-router', () => openAgent(page, 'FX Payment Router'))
  await shot(page, 'd05b-fx-router-full', async () => {}, true)
  await shot(page, 'd06-unowned', async () => { await openAgent(page, 'Branch Rota Planner') })
  await shot(page, 'd07-refund', () => openAgent(page, 'Refund Processor'))
  await shot(page, 'd07b-refund-full', async () => {}, true)
  await shot(page, 'd08-integrations', async () => { await page.goto('/integrations'); await loaded(page) })
  await shot(page, 'd08b-integrations-full', async () => {}, true)
  // The suspend dialog, opened and then closed without suspending.
  for (const name of ['Refund Processor', 'Sales Lead Summariser', 'Invoice Matcher']) {
    await openAgent(page, name)
    if (await page.getByTestId('suspend-button').count()) {
      await shot(page, 'd09-suspend-dialog', async () => {
        await page.getByTestId('suspend-button').click()
        await page.getByRole('dialog').getByLabel('Reason').fill('Refunding interest as well as fees')
        await page.waitForTimeout(400)
      })
      await page.keyboard.press('Escape')
      break
    }
  }
  await shot(page, 'd10-incidents', async () => { await page.goto('/incidents'); await loaded(page) })
  await shot(page, 'd11-incident', async () => {
    await page.goto('/incidents'); await loaded(page)
    await page.locator('main a[href^="/incidents/"]').first().click(); await loaded(page)
  })
  await shot(page, 'd11b-incident-full', async () => {}, true)
  await shot(page, 'd12-routing', async () => { await page.goto('/routing'); await loaded(page) })
  await shot(page, 'd13-alert-routing', async () => { await page.goto('/alert-routing'); await loaded(page) })
  await shot(page, 'd14-users', async () => { await page.goto('/users'); await loaded(page) })
  await shot(page, 'd15-drift', async () => { await page.goto('/drift-sync'); await loaded(page) })
  await shot(page, 'd15b-sync', async () => { await page.goto('/drift-sync?tab=sync'); await loaded(page) })
  await shot(page, 'd16-data-access', async () => { await page.goto('/data-access'); await loaded(page) })
  await shot(page, 'd17-console', async () => { await page.goto('/demo/agent'); await loaded(page) })

  await signIn(page, 'ravi.menon')
  await shot(page, 'd20-approvals', async () => { await page.goto('/approvals'); await loaded(page) })
  await shot(page, 'd20b-approvals-full', async () => {}, true)
  await shot(page, 'd21-request', async () => {
    await page.goto('/approvals'); await loaded(page)
    const big = page.locator('main a[href^="/approvals/requests/"]', { hasText: '2,000,000' })
    await ((await big.count()) ? big.first() : page.locator('main a[href^="/approvals/requests/"]').first()).click()
    await loaded(page)
  })
  await shot(page, 'd21b-request-full', async () => {}, true)
  await shot(page, 'd22-approve-dialog', async () => {
    await page.getByRole('button', { name: 'Approve' }).first().click()
    await page.getByLabel('Note (optional)').fill('Invoice and PO checked')
    await page.waitForTimeout(400)
  })
  await page.keyboard.press('Escape')
  await shot(page, 'd23-my-work', async () => { await page.goto('/my-work'); await loaded(page) })

  await signIn(page, 'priya.sharma')
  await shot(page, 'd30-reports', async () => { await page.goto('/reports'); await loaded(page) })
  await shot(page, 'd31-dashboard', async () => { await page.goto('/dashboard'); await loaded(page); await page.waitForTimeout(1500) })
  await shot(page, 'd31b-dashboard-full', async () => {}, true)
  await shot(page, 'd32-risk', async () => { await page.goto('/risk'); await loaded(page); await page.waitForTimeout(1500) })
  await shot(page, 'd32b-risk-full', async () => {}, true)

  await signIn(page, 'mei.lin')
  await shot(page, 'd40-audit', async () => { await page.goto('/audit'); await loaded(page) })
  await shot(page, 'd41-audit-agent', async () => {
    await page.getByLabel('Agent', { exact: true }).selectOption({ label: 'AGT-0001 Payment Release Assistant' })
    await page.getByRole('button', { name: 'Search' }).click()
    await expect(page.getByTestId('audit-row').first().locator('td').nth(6)).toHaveText('AGT-0001 Payment Release Assistant', { timeout: 20_000 })
  })
  await shot(page, 'd42-audit-entry', async () => {
    await page.getByTestId('audit-row').first().click(); await page.waitForTimeout(600)
  })
  await shot(page, 'd43-evidence', async () => {
    await page.goto('/evidence'); await loaded(page)
    await page.getByLabel('Agent', { exact: true }).selectOption({ label: 'AGT-0001 Payment Release Assistant' })
  })

  await signIn(page, 'james.whitfield')
  await shot(page, 'd50-owner-registry', async () => { await page.goto('/agents'); await loaded(page) })
  await shot(page, 'd51-owner-my-work', async () => { await page.goto('/my-work'); await loaded(page) })

  console.log(`[deck] desktop: ${done.length} pictures${failed.length ? `; failed: ${failed.join(' | ')}` : ''}`)
  await ctx.close()
})

test('deck pictures, phone', async ({ browser, playwright }) => {
  test.setTimeout(8 * 60_000)
  mkdirSync(DIR, { recursive: true })
  const ctx = await browser.newContext({ ...playwright.devices['Pixel 7'] })
  const page = await ctx.newPage()
  done.length = 0; failed.length = 0
  await signIn(page, 'ravi.menon')
  await shot(page, 'p01-approvals', async () => { await page.goto('/approvals'); await loaded(page) })
  await shot(page, 'p02-request', async () => {
    const big = page.locator('main a[href^="/approvals/requests/"]', { hasText: '2,000,000' })
    await ((await big.count()) ? big.first() : page.locator('main a[href^="/approvals/requests/"]').first()).click()
    await loaded(page)
  })
  await shot(page, 'p02b-request-full', async () => {}, true)
  await shot(page, 'p03-approve-dialog', async () => {
    await page.getByRole('button', { name: 'Approve' }).first().click()
    await page.getByLabel('Note (optional)').fill('Invoice and PO checked')
    await page.waitForTimeout(400)
  })
  await page.keyboard.press('Escape')
  await shot(page, 'p04-my-work', async () => { await page.goto('/my-work'); await loaded(page) })
  await signIn(page, 'priya.sharma')
  await shot(page, 'p05-dashboard', async () => { await page.goto('/dashboard'); await loaded(page); await page.waitForTimeout(1500) })
  await signIn(page, 'admin')
  await shot(page, 'p06-agent', () => openAgent(page, 'Payment Release Assistant'))
  console.log(`[deck] phone: ${done.length} pictures${failed.length ? `; failed: ${failed.join(' | ')}` : ''}`)
  await ctx.close()
})
