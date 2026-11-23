import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

// Pictures for the step-by-step guide deck (23 Nov). Opens pages and dialogs only: it never saves, approves, suspends,
// syncs or creates anything, so it is safe on the client demo site. For each picture it records where the buttons and
// fields to click are (CSS px in a 1440×900 window, or the phone's), so the deck can number them on the picture.
const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const DIR = process.env.SCREENS_DIR ?? 'deck-guide'
test.skip(!PASSWORD || !process.env.DECK_SCREENS, 'run by the Deck screens workflow')

type Mark = { n: number; label: string; x: number; y: number; w: number; h: number }
const boxes: Record<string, { marks: Mark[]; missing: string[]; vw: number; vh: number }> = {}

async function loaded(page: Page) {
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('main [aria-label="Loading"], main [data-slot="skeleton"]')).toHaveCount(0, { timeout: 20_000 })
  await page.waitForTimeout(700)
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
async function go(page: Page, path: string) { await page.goto(path); await loaded(page) }
async function openAgent(page: Page, name: string) {
  await go(page, '/agents')
  await page.getByLabel('Search agents').fill(name)
  await page.getByRole('link', { name }).first().click()
  await loaded(page)
}

const failed: string[] = []
async function shot(page: Page, name: string, setup: () => Promise<void>,
  marks: [string, (p: Page) => Locator][], opts: { scrollTo?: (p: Page) => Locator } = {}) {
  try {
    await setup()
    if (opts.scrollTo) {
      await opts.scrollTo(page).first().evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await page.waitForTimeout(400)
    }
    const vs = page.viewportSize()!
    const rec = { marks: [] as Mark[], missing: [] as string[], vw: vs.width, vh: vs.height }
    let n = 0
    for (const [label, loc] of marks) {
      n++
      try {
        const b = await loc(page).first().boundingBox({ timeout: 3000 })
        if (!b || b.y + b.height < 0 || b.y > vs.height) { rec.missing.push(`${n} ${label} (off screen)`); continue }
        rec.marks.push({ n, label, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) })
      } catch { rec.missing.push(`${n} ${label}`) }
    }
    await page.screenshot({ path: `${DIR}/${name}.png` })
    boxes[name] = rec
  } catch (e) { failed.push(`${name}: ${String(e).split('\n')[0]}`) }
}
const btn = (name: string | RegExp) => (p: Page) => p.getByRole('button', { name })
const link = (name: string | RegExp) => (p: Page) => p.getByRole('link', { name })
const lbl = (name: string | RegExp) => (p: Page) => p.getByLabel(name)
const head = (name: string | RegExp) => (p: Page) => p.locator('header').getByRole('link', { name })
const txt = (t: string) => (p: Page) => p.getByText(t, { exact: true })
const dlg = (f: (d: Locator) => Locator) => (p: Page) => f(p.getByRole('dialog'))

test('guide pictures, desktop', async ({ browser }) => {
  test.setTimeout(25 * 60_000)
  mkdirSync(DIR, { recursive: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()

  await shot(page, 'g01-login', async () => { await page.goto('/login'); await page.getByLabel('Email').waitFor() },
    [['Email', lbl('Email')], ['Password', lbl('Password')], ['Sign in', btn('Sign in')]])

  // ---------- Admin ----------
  await signIn(page, 'admin')
  await shot(page, 'g02-nav', () => go(page, '/agents'), [
    ['Agents', head(/^Agents$/)], ['My work', head(/^My work/)], ['Approvals', head(/^Approvals/)], ['Incidents', head(/^Incidents/)],
    ['Reports', head(/^Reports/)], ['Integrations', head(/^Integrations/)], ['Routing', head(/^Routing/)], ['Alerts', head(/^Alerts/)],
    ['Users', head(/^Users/)], ['Notifications', btn(/^Notifications/)], ['Change password', link('Change password')], ['Sign out', btn('Sign out')]])
  await shot(page, 'g03-password', () => go(page, '/account/password'), [
    ['Current password', (p) => p.locator('main input').nth(0)], ['New password', (p) => p.locator('main input').nth(1)],
    ['Repeat', (p) => p.locator('main input').nth(2)], ['Save', (p) => p.locator('main button[type="submit"]')]])
  await shot(page, 'g04-registry', () => go(page, '/agents'), [
    ['No owner tile', (p) => p.locator('main button, main a').filter({ hasText: 'No owner' })], ['Search', lbl('Search agents')],
    ['Status', lbl('Filter by status')], ['Risk', lbl('Filter by risk')], ['Source', lbl('Filter by source')],
    ['Register agent', link(/Register agent/)], ['An agent', link('Payment Release Assistant')]])
  await shot(page, 'g05-agent', () => openAgent(page, 'Payment Release Assistant'), [
    ['Record review', btn('Record review')], ['Suspend', (p) => p.getByTestId('suspend-button')], ['Report incident', (p) => p.getByTestId('report-incident')],
    ['Retire', btn('Retire')], ['Ownership', txt('Ownership')], ['People with access', txt('People with access')]])
  await shot(page, 'g06-agent-keys', async () => {}, [['API keys', txt('API keys')], ['New key', btn(/New key/)]], { scrollTo: txt('API keys') })
  await shot(page, 'g07-review', async () => { await page.evaluate(() => window.scrollTo(0, 0)); await btn('Record review')(page).click(); await page.getByRole('dialog').waitFor() },
    [['Notes', dlg((d) => d.locator('textarea'))], ['Save review', dlg((d) => d.getByRole('button', { name: /Save review/ }))]])
  await page.keyboard.press('Escape')
  await shot(page, 'g08-report', async () => { await page.getByTestId('report-incident').click(); await page.getByRole('dialog').waitFor() }, [
    ['Title', dlg((d) => d.locator('input').first())], ['Severity', dlg((d) => d.locator('select').first())],
    ['What happened', dlg((d) => d.locator('textarea').first())], ['Report incident', (p) => p.getByTestId('report-incident-confirm')]])
  await page.keyboard.press('Escape')
  await shot(page, 'g09-form-top', () => go(page, '/agents/new'), [
    ['Name', lbl(/^Name/)], ['Description', lbl(/^Description/)], ['Built by', lbl(/^Built by/)],
    ['Business owner', lbl(/^Business owner/)], ['Department', lbl(/^Department/)]])
  await shot(page, 'g10-form-purpose', async () => {}, [
    ['Purpose statement', lbl(/Purpose statement/)], ['Allowed actions', lbl(/Allowed actions|In-scope actions/i)], ['Forbidden actions', lbl(/Forbidden actions|Out-of-scope/i)]],
  { scrollTo: lbl(/Purpose statement/) })
  await shot(page, 'g11-form-bottom', async () => {}, [
    ['Autonomy', lbl(/^Autonomy/)], ['Risk tier', lbl(/^Risk tier|^Risk/)], ['Save as Proposed', btn('Save as Proposed')]],
  { scrollTo: btn('Save as Proposed') })
  await shot(page, 'g12-discovered', () => openAgent(page, 'Refund Processor'), [
    ['Edit', link(/^Edit$/)], ['Submit for approval', btn(/Submit for approval/)], ['Not registered notice', (p) => p.getByText(/is not registered/).first()]])
  await shot(page, 'g13-integrations', () => go(page, '/integrations'), [
    ['Test connection', btn('Test connection')], ['Sync now', btn(/Sync now/)], ['How often', lbl('Sync the agent list')],
    ['Check now', (p) => p.getByTestId('reconcile-now')], ['Agent console', link(/Agent console/)]])
  await shot(page, 'g14-suspend', async () => {
    await openAgent(page, 'Invoice Matcher')
    await page.getByTestId('suspend-button').click()
    await page.getByRole('dialog').getByLabel('Reason').fill('Refunding interest as well as fees')
    await page.waitForTimeout(300)
  }, [['Reason', dlg((d) => d.getByLabel('Reason'))], ['Suspend now', btn('Suspend now')]])
  await page.keyboard.press('Escape')
  await shot(page, 'g15-incidents', () => go(page, '/incidents'), [
    ['Open', (p) => p.locator('main button, main a').filter({ hasText: /^\d+\s*Open$/ })], ['Overdue', (p) => p.locator('main button, main a').filter({ hasText: /Overdue$/ })],
    ['An incident', (p) => p.locator('main a[href^="/incidents/"]')]])
  await shot(page, 'g16-incident', async () => { await go(page, '/incidents'); await page.locator('main a[href^="/incidents/"]').first().click(); await loaded(page) }, [
    ['Mark contained', (p) => p.getByTestId('mark-contained')], ['Mark resolved', btn('Mark resolved')], ['Change severity', btn('Change severity')],
    ['Hand over', btn('Hand over')], ['Impact', txt('Impact')], ['Containment', txt('Containment')]])
  await shot(page, 'g17-incident-save', async () => {}, [
    ['Root cause', txt('Root cause')], ['Remediation', txt('Remediation')], ['Save case', btn('Save case')]], { scrollTo: btn('Save case') })
  await shot(page, 'g18-routing', () => go(page, '/routing'), [
    ['Add rule', btn(/Add rule/)], ['Apply to waiting requests', btn(/Apply to waiting/)], ['Move or edit a rule', (p) => p.locator('main li button').first()],
    ['Time to decide', lbl(/^Critical/)], ['Save time limits', btn(/Save time limits/)]])
  await shot(page, 'g19-routing-add', async () => { await btn(/Add rule/)(page).click(); await page.waitForTimeout(600) }, [
    ['Rule form', (p) => p.getByRole('dialog').or(p.locator('main form')).first()], ['Save', (p) => p.getByRole('button', { name: /^Save|Add rule$/ }).last()]])
  await page.keyboard.press('Escape')
  await shot(page, 'g20-alert-routing', () => go(page, '/alert-routing'), [
    ['Add route', btn(/Add route/)], ['Default route: edit', (p) => p.locator('main button').filter({ has: p.locator('svg') }).nth(1)],
    ['Choose an agent', (p) => p.locator('main select').nth(0)], ['Choose an alert', (p) => p.locator('main select').nth(1)], ['Test', btn(/^Test$/)]])
  await shot(page, 'g21-alert-test', async () => {
    const agent = page.locator('main select').nth(0)
    const v = await agent.locator('option').nth(1).getAttribute('value')
    if (v) await agent.selectOption(v)
    await btn(/^Test$/)(page).click()
    await page.waitForTimeout(1500)
  }, [['Test', btn(/^Test$/)]])
  await shot(page, 'g22-users', () => go(page, '/users'), [
    ['Add person', (p) => p.getByRole('link', { name: /Add person/ }).or(p.getByRole('button', { name: /Add person/ }))], ['Search', (p) => p.locator('main input').first()],
    ['Role', (p) => p.locator('main select').nth(0)], ['A person', (p) => p.locator('main a[href^="/users/"]').first()]])
  await shot(page, 'g23-user-new', () => go(page, '/users/new'), [
    ['Name', (p) => p.locator('main input').nth(0)], ['Email', (p) => p.locator('main input[type="email"]')],
    ['Roles', (p) => p.locator('main input[type="checkbox"]').first()], ['Save', (p) => p.locator('main button[type="submit"]')]])
  await shot(page, 'g24-console', () => go(page, '/demo/agent'), [
    ['Amount', (p) => p.locator('main input').nth(0)], ['Supplier', (p) => p.locator('main input').nth(1)],
    ['Why', (p) => p.locator('main textarea').first()], ['Ask the Control Tower', btn(/Ask the Control Tower/)]])
  await shot(page, 'g25-bell', async () => { await go(page, '/agents'); await btn(/^Notifications/)(page).click(); await page.getByTestId('notification-panel').waitFor() },
    [['Notifications', btn(/^Notifications/)], ['Latest alert', (p) => p.getByTestId('notification-panel').locator('a, li').first()]])
  await page.keyboard.press('Escape')

  // ---------- Approver ----------
  await signIn(page, 'ravi.menon')
  const big = (p: Page) => p.locator('main a[href^="/approvals/requests/"]', { hasText: '2,000,000' })
  await shot(page, 'g30-approvals', () => go(page, '/approvals'), [
    ['Approvals', head(/^Approvals/)], ['An incident to close', (p) => p.locator('main a[href^="/incidents/"]')], ['The £2m request', big]])
  await shot(page, 'g31-new-agents', async () => {}, [['New agents', txt('New agents')], ['An agent to approve', (p) => p.locator('main a[href^="/agents/"]')]], { scrollTo: txt('New agents') })
  await shot(page, 'g32-request', async () => { await go(page, '/approvals'); await big(page).first().click(); await loaded(page) }, [
    ['Why it needs a person', txt('Why it needs a person')], ['Approve', btn(/^Approve$/)], ['Reject', btn(/^Reject$/)], ['Escalate', btn(/^Escalate$/)]])
  const reqUrl = page.url()
  await shot(page, 'g33-approve', async () => { await btn(/^Approve$/)(page).click(); await page.getByLabel('Note (optional)').fill('Invoice and PO checked') }, [
    ['Note', lbl('Note (optional)')], ['Confirm approval', btn('Confirm approval')]])
  await shot(page, 'g34-reject', async () => { await page.goto(reqUrl); await loaded(page); await btn(/^Reject$/)(page).click(); await page.waitForTimeout(500) }, [
    ['Reason', (p) => p.locator('main textarea').first()], ['Confirm', (p) => p.getByRole('button', { name: /Confirm/ }).first()]])
  await shot(page, 'g35-escalate', async () => { await page.goto(reqUrl); await loaded(page); await btn(/^Escalate$/)(page).click(); await page.waitForTimeout(500) }, [
    ['Escalate to', (p) => p.locator('main select').first()], ['Confirm', (p) => p.getByRole('button', { name: /Confirm|Escalate/ }).last()]])
  await shot(page, 'g36-fx', () => openAgent(page, 'FX Payment Router'), [
    ['Approve', btn(/^Approve$/)], ['Send back', btn(/^Send back$/)], ['Reject', btn(/^Reject$/)]])
  await shot(page, 'g37-close-incident', async () => { await go(page, '/approvals'); await page.locator('main a[href^="/incidents/"]').first().click(); await loaded(page) }, [
    ['Approve and close', (p) => p.getByTestId('approve-close')], ['Turn down', btn(/Turn down/)]])
  await shot(page, 'g38-my-work', () => go(page, '/my-work'), [
    ['Past due', txt('Past due')], ['Waiting for my decision', txt('Waiting for my decision')], ['A decision', (p) => p.locator('main a').filter({ hasText: 'REQ-' }).first()]])

  await signIn(page, 'omar.farouk')
  await shot(page, 'g39-bulk', async () => {
    await go(page, '/approvals')
    const all = page.getByLabel('Select all low-risk requests')
    if (await all.count()) await all.check()
    await page.waitForTimeout(300)
  }, [['Select all low-risk', lbl('Select all low-risk requests')], ['Or one by one', (p) => p.getByLabel(/^Select REQ-/).first()], ['Approve selected', btn(/Approve selected/)]])

  // ---------- Executive and auditor ----------
  await signIn(page, 'priya.sharma')
  await shot(page, 'g40-reports', () => go(page, '/reports'), [
    ['Executive dashboard', link(/Executive dashboard/)], ['Risk dashboard', link(/Risk dashboard/)], ['Drift and sync', link(/Drift and sync/)],
    ['Data access mismatches', link(/Data access mismatches/)], ['Audit trail', link(/Audit trail/)], ['Evidence pack', link(/Evidence pack/)]])
  await shot(page, 'g41-dashboard', async () => { await go(page, '/dashboard'); await page.waitForTimeout(1200) }, [
    ['Refresh', btn(/Refresh/)], ['Without an owner', txt('Without an owner')], ['Figures as a table', (p) => p.getByText('Figures as a table').first()]])
  await shot(page, 'g42-risk', async () => { await go(page, '/risk'); await page.waitForTimeout(1200) }, [
    ['Refresh', btn(/Refresh/)], ['Heat map', txt('Agents by department and risk tier')], ['Breaches', txt('Breaches, week by week')], ['Most incidents', txt('Agents with the most incidents')]])

  await signIn(page, 'mei.lin')
  await shot(page, 'g43-drift', () => go(page, '/drift-sync'), [
    ['Drift report tab', (p) => p.getByRole('tab', { name: 'Drift report' }).or(p.getByText('Drift report', { exact: true })).first()],
    ['Sync health tab', (p) => p.getByRole('tab', { name: 'Sync health' }).or(p.getByText('Sync health', { exact: true })).first()],
    ['From', lbl(/^From/)], ['Show', btn(/^Show$/)], ['What changed', (p) => p.locator('main select').nth(0)], ['Agent', (p) => p.getByPlaceholder('Name, code or platform ID')],
    ['CSV', btn(/CSV/)]])
  await shot(page, 'g44-data-access', () => go(page, '/data-access'), [
    ['Refresh', btn(/Refresh/)], ['Personal data', btn(/^Personal data$/)], ['All sensitive data', btn(/All sensitive data/)], ['CSV', btn(/CSV/)]])
  await shot(page, 'g45-audit', () => go(page, '/audit'), [
    ['Words', lbl('Words')], ['From', lbl('From')], ['To', lbl(/^To/)], ['Agent', (p) => p.getByLabel('Agent', { exact: true })], ['Who', lbl('Who')], ['Record', lbl('Record')],
    ['Search', btn(/^Search$/)], ['Export CSV', btn(/Export CSV/)], ['Export JSON', btn(/Export JSON/)]])
  await shot(page, 'g46-audit-row', async () => {
    await page.getByLabel('Agent', { exact: true }).selectOption({ label: 'AGT-0001 Payment Release Assistant' })
    await btn(/^Search$/)(page).click()
    await expect(page.getByTestId('audit-row').first().locator('td').nth(6)).toHaveText('AGT-0001 Payment Release Assistant', { timeout: 20_000 })
    await page.getByTestId('audit-row').first().click(); await page.waitForTimeout(600)
  }, [['Agent', (p) => p.getByLabel('Agent', { exact: true })], ['Search', btn(/^Search$/)], ['Open an entry', (p) => p.getByTestId('audit-row').first()], ['Export JSON', btn(/Export JSON/)]])
  await shot(page, 'g47-evidence', async () => {
    await go(page, '/evidence')
    await btn('Last 90 days')(page).click()
    await page.getByLabel('Agent', { exact: true }).selectOption({ label: 'AGT-0001 Payment Release Assistant' })
  }, [['A preset', btn('Last 90 days')], ['Or dates', lbl(/^From/)], ['Agent', (p) => p.getByLabel('Agent', { exact: true })], ['Download PDF', btn(/Download PDF/)], ['Download Excel', btn(/Download Excel/)]])

  // ---------- Agent owner ----------
  await signIn(page, 'james.whitfield')
  await shot(page, 'g48-owner-my-work', () => go(page, '/my-work'), [
    ['Past due', txt('Past due')], ['The overdue review', (p) => p.getByText(/Review of AGT-0001/).first()], ['My agents', txt('My agents')]])

  writeFileSync(`${DIR}/boxes.json`, JSON.stringify(boxes, null, 1))
  console.log(`[deck-guide] desktop: ${Object.keys(boxes).length} pictures${failed.length ? `; failed: ${failed.join(' | ')}` : ''}`)
  for (const [k, v] of Object.entries(boxes)) if (v.missing.length) console.log(`[deck-guide] ${k} missing: ${v.missing.join(', ')}`)
  await ctx.close()
})


test('guide pictures, phone', async ({ browser, playwright }) => {
  test.setTimeout(8 * 60_000)
  mkdirSync(DIR, { recursive: true })
  const ctx = await browser.newContext({ ...playwright.devices['Pixel 7'] })
  const page = await ctx.newPage()
  const phone: typeof boxes = {}
  const keep = { ...boxes }
  for (const k of Object.keys(boxes)) delete boxes[k]
  await signIn(page, 'ravi.menon')
  const big = (p: Page) => p.locator('main a[href^="/approvals/requests/"]', { hasText: '2,000,000' })
  await shot(page, 'q01-approvals', () => go(page, '/approvals'), [['Approvals tab', (p) => p.getByRole('link', { name: /Approvals/ }).last()], ['The request', big]])
  await shot(page, 'q02-request', async () => { await big(page).first().click(); await loaded(page) }, [['Approve', btn(/^Approve$/)]], { scrollTo: btn(/^Approve$/) })
  await shot(page, 'q03-approve', async () => { await btn(/^Approve$/)(page).click(); await page.getByLabel('Note (optional)').fill('Invoice and PO checked') }, [
    ['Note', lbl('Note (optional)')], ['Confirm approval', btn('Confirm approval')]], { scrollTo: btn('Confirm approval') })
  Object.assign(phone, boxes)
  writeFileSync(`${DIR}/boxes-phone.json`, JSON.stringify(phone, null, 1))
  Object.assign(boxes, keep)
  console.log(`[deck-guide] phone: ${Object.keys(phone).length} pictures${failed.length ? `; failed: ${failed.join(' | ')}` : ''}`)
  for (const [k, v] of Object.entries(phone)) if (v.missing.length) console.log(`[deck-guide] ${k} missing: ${v.missing.join(', ')}`)
  await ctx.close()
})
