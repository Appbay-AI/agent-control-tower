import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

// Task 7.4 (polish): every page, on a phone and on a desktop, as the people who use it. Each must load (no loading
// placeholders left) within the time below, fit the screen with no sideways scrolling, and log no errors. With
// SCREENS_DIR set (the Screens workflow), a full-page picture of each is saved for review.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const SCREENS = process.env.SCREENS_DIR ?? ''
const LIMIT_MS = 6_000

type Visit = { name: string; who: string; path: string | ((page: Page) => Promise<string | null>) }

// Detail pages are reached from their lists, so the test works on any copy of the demo data.
const firstLink = (list: string, prefix: string) => async (page: Page) => {
  await page.goto(list)
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('main [aria-label="Loading"], main [data-slot="skeleton"]')).toHaveCount(0, { timeout: 20_000 })
  const a = page.locator(`main a[href^="${prefix}"]`).first()
  return (await a.count()) ? a.getAttribute('href') : null
}

const PAGES: Visit[] = [
  { name: 'agents', who: 'admin', path: '/agents' },
  { name: 'agent', who: 'admin', path: async (page) => {
    await page.goto('/agents')
    await page.getByLabel('Search agents').fill('Payment Release Assistant')
    const a = page.getByRole('link', { name: 'Payment Release Assistant' }).first()
    await a.waitFor()
    return a.getAttribute('href')
  } },
  { name: 'agent-new', who: 'admin', path: '/agents/new' },
  { name: 'my-work', who: 'ravi.menon', path: '/my-work' },
  { name: 'approvals', who: 'ravi.menon', path: '/approvals' },
  { name: 'request', who: 'ravi.menon', path: firstLink('/approvals', '/approvals/requests/') },
  { name: 'incidents', who: 'admin', path: '/incidents' },
  { name: 'incident', who: 'admin', path: firstLink('/incidents', '/incidents/') },
  { name: 'reports', who: 'priya.sharma', path: '/reports' },
  { name: 'dashboard', who: 'priya.sharma', path: '/dashboard' },
  { name: 'risk', who: 'priya.sharma', path: '/risk' },
  { name: 'drift', who: 'mei.lin', path: '/drift-sync' },
  { name: 'sync-health', who: 'mei.lin', path: '/drift-sync?tab=sync' },
  { name: 'data-access', who: 'mei.lin', path: '/data-access' },
  { name: 'audit', who: 'mei.lin', path: '/audit' },
  { name: 'evidence', who: 'mei.lin', path: '/evidence' },
  { name: 'integrations', who: 'admin', path: '/integrations' },
  { name: 'routing', who: 'admin', path: '/routing' },
  { name: 'alert-routing', who: 'admin', path: '/alert-routing' },
  { name: 'users', who: 'admin', path: '/users' },
  { name: 'user-new', who: 'admin', path: '/users/new' },
  { name: 'agent-console', who: 'admin', path: '/demo/agent' },
  { name: 'password', who: 'james.whitfield', path: '/account/password' },
]

async function signIn(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

for (const device of ['desktop', 'phone'] as const) {
  const tag = device === 'phone' ? ' @phone' : ''
  test(`every page loads in under ${LIMIT_MS / 1000} s, fits the screen and logs no errors (${device})${tag}`, async ({ page }, info) => {
    test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
    test.skip(info.project.name !== device, `runs in the ${device} project`)
    test.setTimeout(PAGES.length * 30_000)
    if (SCREENS) mkdirSync(SCREENS, { recursive: true })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(`${page.url()}: ${m.text()}`) })

    const problems: string[] = []
    const times: string[] = []
    let signedInAs = ''
    for (const v of PAGES) {
      if (signedInAs !== v.who) {
        await page.context().clearCookies()
        await page.goto('/login')
        await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* private mode */ } })
        await signIn(page, v.who)
        signedInAs = v.who
      }
      const path = typeof v.path === 'string' ? v.path : await v.path(page)
      if (!path) { times.push(`${v.name} (nothing to open)`); continue }
      const started = Date.now()
      await page.goto(path)
      // Loaded: a page heading, and no loading placeholders left in the page.
      await expect(page.locator('main h1').first()).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('main [aria-label="Loading"], main [data-slot="skeleton"]')).toHaveCount(0, { timeout: 20_000 })
      const ms = Date.now() - started
      times.push(`${v.name} ${ms}`)
      if (ms > LIMIT_MS) problems.push(`${v.name} took ${ms} ms to load`)
      const over = await page.evaluate(() => {
        const w = document.documentElement.clientWidth
        const wide = [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((el) => {
            const r = el.getBoundingClientRect()
            if (r.width === 0 || r.right <= w + 1) return false
            // Inside something that scrolls sideways on purpose (wide tables): fine.
            for (let p = el.parentElement; p; p = p.parentElement) {
              const o = getComputedStyle(p).overflowX
              if (o === 'auto' || o === 'scroll' || o === 'hidden') return false
            }
            return true
          })
          .slice(0, 3)
          .map((el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${(el.textContent ?? '').trim().slice(0, 40)}"`)
        return { page: document.documentElement.scrollWidth, screen: w, wide }
      })
      if (over.page > over.screen + 1) problems.push(`${v.name} is ${over.page - over.screen}px wider than the screen: ${over.wide.join('; ')}`)
      if (SCREENS) await page.screenshot({ path: `${SCREENS}/${device}-${v.name}.png`, fullPage: true })
    }
    console.log(`[pages] ${device}: ${times.join(', ')} (ms)`)
    expect(problems, problems.join('\n')).toEqual([])
    expect(errors, errors.join('\n')).toEqual([])
  })
}
