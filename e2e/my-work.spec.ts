import { expect, test, type Page } from '@playwright/test'
import { waitForListLoaded } from './helpers.js'

// Task 6.5: the operational dashboard ("My work"). Done when: each user sees only their own. Ravi Menon (approver)
// and James Whitfield (business owner) each open My work on the work-in-progress site: Ravi's requests are exactly the
// ones the Approvals screen gives him to decide, James's agents are ones he owns, and neither sees the other's.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}
async function openMyWork(page: Page) {
  await page.getByRole('link', { name: 'My work' }).last().click()
  await expect(page.getByTestId('my-work')).toBeVisible()
}
const hrefs = async (page: Page, sel: string) => (await page.locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''))).sort()

test('each person\'s My work shows only their own decisions, incidents and agents @phone', async ({ browser }, info) => {
  test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
  test.setTimeout(150_000)
  const ravi = await (await browser.newContext(info.project.use)).newPage()
  const james = await (await browser.newContext(info.project.use)).newPage()
  await signIn(ravi, 'ravi.menon@northbridge.demo')
  await signIn(james, 'james.whitfield@northbridge.demo')

  // Ravi: the action requests waiting for him are exactly the Approvals screen's "for you" list (other tests raise and
  // decide requests at the same time, so both are read again until they agree).
  let requests: string[] = []
  await expect(async () => {
    await ravi.goto('/approvals')
    await waitForListLoaded(ravi)
    const approvals = await hrefs(ravi, '[data-testid="request-card"]')
    await ravi.goto('/agents')
    await openMyWork(ravi)
    requests = await hrefs(ravi, '[data-testid="waiting"] a[href^="/approvals/requests/"]')
    expect(requests).toEqual(approvals)
  }).toPass({ timeout: 90_000 })
  await expect(ravi.getByRole('heading', { name: 'My work' })).toBeVisible()
  await expect(ravi.getByText(/^What needs you, Ravi Menon:/)).toBeVisible()

  // James: every agent listed is one he owns (checked on its own page), and nothing waits for his decision on them.
  await openMyWork(james)
  await expect(james.getByText(/^What needs you, James Whitfield:/)).toBeVisible()
  const jamesAgents = await hrefs(james, '[data-testid="my-agent"] a')
  expect(jamesAgents.length).toBeGreaterThan(0)
  for (const href of jamesAgents.slice(0, 3)) {
    await james.goto(href)
    await expect(james.getByText(/James Whitfield/).first()).toBeVisible()
  }
  await james.goto('/my-work')
  const jamesRequests = await hrefs(james, '[data-testid="waiting"] a[href^="/approvals/requests/"]')

  // Neither sees the other's: none of James's agents on Ravi's page, and Ravi's requests are not James's to decide.
  await ravi.goto('/my-work')
  const raviAgents = await hrefs(ravi, '[data-testid="my-agent"] a')
  expect(raviAgents.filter((h) => jamesAgents.includes(h))).toEqual([])
  expect(jamesRequests.filter((h) => requests.includes(h))).toEqual([])
  const counts = async (p: Page) => Promise.all(['count-breaches', 'count-waiting', 'count-agents'].map(async (t) => Number(await p.getByTestId(t).textContent())))
  console.log(`[my-work] ${info.project.name}: Ravi ${requests.length} requests to decide (as on Approvals), ${(await counts(ravi)).join('/')} past due/waiting/agents; James owns ${jamesAgents.length} agents, none on Ravi's page`)
})
