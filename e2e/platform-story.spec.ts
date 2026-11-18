import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

// Task 7.3: the platform story end to end, as it is told in the demo, on the registry agent linked to NAP-001
// (Refund Processor) on the Appian simulator: found by the sync; suspended in Control Tower and blocked in Appian
// (task 4.2); the agent itself stops (its key is refused); someone switches it back on directly in Appian; the
// reconciliation check (Check now) blocks it again with a Critical incident (task 4.7); the alert emails and the drift
// report show it (tasks 5.1, 6.6); and it comes back only through approval, switched back on in Appian (task 4.6).
// The e2e workflow makes the test agent Live, gives it a key, and switches NAP-001 back on and the agent back to Live
// afterwards. Replaces the task 4.2 enforcement test, which it contains.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const CODE = process.env.ACT_PLATFORM_AGENT_CODE ?? ''
const KEY = process.env.ACT_PLATFORM_AGENT_KEY ?? ''
const APPIAN = (process.env.APPIAN_BASE ?? 'https://appbay-demo.appiancloud.com').replace(/\/+$/, '')
const APPIAN_KEY = process.env.APPIAN_API_KEY ?? ''
const PLATFORM = 'Northbridge Agent Platform (simulated)'

async function signIn(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

// What Appian itself says about NAP-001.
async function appianStatus(request: APIRequestContext): Promise<string> {
  const r = await request.get(`${APPIAN}/suite/webapi/nap-agent-status?externalId=NAP-001`, { headers: { 'Appian-API-Key': APPIAN_KEY } })
  expect(r.ok()).toBe(true)
  return (await r.json()).status as string
}

// What the agent hears when it asks whether it may act (the check every demo agent makes before acting).
async function agentMayAct(request: APIRequestContext): Promise<{ http: number; mayAct: boolean }> {
  const r = await request.get(`/api/v1/agents/${CODE}/status`, { headers: { Authorization: `Bearer ${KEY}` } })
  const body = await r.json().catch(() => ({}))
  return { http: r.status(), mayAct: r.status() === 200 && body.may_act === true }
}

// One long story that changes the agent as it goes: a retry would start half way through, so a failure is reported as it is.
test.describe.configure({ retries: 0 })

test('the platform story: found, suspended and blocked in Appian, the agent stops, switched back on in Appian, blocked again, incident, email, drift report; back only through approval', async ({ page, browser, baseURL, request }, info) => {
  test.skip(!PASSWORD || !CODE || !KEY || !APPIAN_KEY,
    'DEMO_USER_PASSWORD, ACT_PLATFORM_AGENT_CODE, ACT_PLATFORM_AGENT_KEY and APPIAN_API_KEY are set by the e2e workflow')
  test.setTimeout(6 * 60_000)
  const story: string[] = []
  await signIn(page, 'admin')

  // 1. Found on the platform: Sync now lists Appian's agents; NAP-001 is in the registry, active there, and may act.
  await page.goto('/integrations')
  const connection = page.getByTestId('platform-connection').filter({ hasText: PLATFORM })
  await connection.getByRole('button', { name: 'Sync now' }).click()
  await expect(connection.getByTestId('platform-sync')).toContainText(/^Synced \d+ agents? from /, { timeout: 60_000 })
  await page.goto('/agents')
  await page.getByLabel('Search agents').fill(CODE)
  await page.getByRole('link', { name: 'Refund Processor' }).first().click()
  await expect(page.getByTestId('agent-code')).toHaveText(CODE)
  const record = page.getByTestId('platform-record')
  await expect(record).toContainText('NAP-001')
  await expect(record).toContainText('Active on the platform')
  expect(await agentMayAct(request)).toEqual({ http: 200, mayAct: true })
  const agentUrl = page.url()
  story.push('found by the sync')

  // 2. Suspended in Control Tower: blocked in Appian and read back; the agent's own check is refused.
  await page.getByTestId('suspend-button').click()
  const reason = `E2E platform story ${Date.now()}`
  await page.getByRole('dialog').getByLabel('Reason').fill(reason)
  const pressed = Date.now()
  await page.getByRole('button', { name: 'Suspend now' }).click()
  const stop = page.getByTestId('enforcement-platform').filter({ hasText: 'read back as blocked' }).first()
  await expect(stop).toContainText(`Blocked on ${PLATFORM} as NAP-001; read back as blocked`, { timeout: 60_000 })
  await expect(stop).toContainText('Done')
  const took = Date.now() - pressed
  console.log(`[enforcement] blocked in Appian and read back ${took} ms after Suspend now`)
  info.annotations.push({ type: 'enforcement', description: `${took} ms` })
  expect(await appianStatus(request)).toBe('quarantined')
  const refused = await agentMayAct(request)
  expect(refused.mayAct).toBe(false)
  story.push(`blocked in Appian ${(took / 1000).toFixed(1)} s after Suspend now; the agent's check refused (HTTP ${refused.http})`)
  await page.reload()
  await expect(record).toContainText('Blocked on the platform')

  // 3. Someone switches it back on directly in Appian, outside Control Tower.
  const outside = await request.post(`${APPIAN}/suite/webapi/nap-agent-status-set`, {
    headers: { 'Appian-API-Key': APPIAN_KEY },
    data: { externalId: 'NAP-001', status: 'active', reason: 'E2E platform story: switched back on in Appian', requestedBy: 'maria.lopez' } })
  expect(outside.ok()).toBe(true)
  expect(await appianStatus(request)).toBe('active')

  // 4. The reconciliation check (Check now, instead of waiting for the 5-minute clock) blocks it again, with a
  //    Critical incident; Appian reads it as blocked again.
  await page.goto('/integrations')
  const switchedOn = Date.now()
  await connection.getByTestId('reconcile-now').click()
  // The line shows the latest check, which may be an earlier one at first: follow the agent's own page instead, read
  // again until the re-block step of this suspension is there and done.
  const reblock = page.getByTestId('enforcement-platform').filter({ hasText: 'Blocked again (switched on outside Control Tower):' })
  await expect(async () => {
    await page.goto(agentUrl)
    await expect(reblock).toContainText('Done', { timeout: 3_000 })
  }).toPass({ timeout: 90_000, intervals: [2_000] })
  const took2 = Date.now() - switchedOn
  await page.goto('/integrations')
  await expect(connection.getByTestId('platform-reconcile'))
    .toContainText(`${CODE} switched back on outside Control Tower: blocking again, Critical incident opened`)
  await page.goto(agentUrl)
  await expect.poll(() => appianStatus(request), { timeout: 30_000 }).toBe('quarantined')
  const critical = page.getByTestId('incident-row').filter({ hasText: `${CODE} switched back on outside Control Tower` }).first()
  await expect(critical).toBeVisible()
  await expect(critical).toContainText(/Critical/i)
  story.push(`switched on in Appian by maria.lopez; blocked again ${(took2 / 1000).toFixed(1)} s after Check now, Critical incident`)

  // 5. The alert emails (to the admins and the business owner): suspended, and blocked again.
  const emails = page.getByTestId('agent-alert-emails')
  await expect(emails.locator('[data-testid="alert-email"][data-event="suspended"]').first()).toBeVisible()
  await expect(emails.locator('[data-testid="alert-email"][data-event="re_quarantined"]').first()).toBeVisible()
  story.push('alert emails for the suspension and the re-block')

  // 6. The drift report names who did it and what Control Tower did.
  await page.getByRole('link', { name: 'Reports' }).click()
  await page.getByRole('link', { name: /^Drift and sync/ }).click()
  await expect(page.getByTestId('drift-report')).toBeVisible()
  const drift = page.getByTestId('drift-row').filter({ hasText: `maria.lopez on ${PLATFORM} (outside Control Tower)` }).filter({ hasText: CODE }).first()
  // The result is filled in once the re-block is read back; the report is read again until it shows.
  await expect(async () => {
    await page.reload()
    await page.getByLabel('Agent').fill(CODE)
    await expect(drift).toHaveAttribute('data-kind', 'switched_on_outside', { timeout: 5_000 })
    await expect(drift).toContainText('Blocked again and read back as blocked', { timeout: 1_000 })
  }).toPass({ timeout: 60_000 })
  story.push('drift report: switched on outside by maria.lopez, blocked again')

  // 7. It comes back only through approval. Both incidents of this story (the suspension's and the Critical one from
  //    the re-block) must be Contained first.
  await page.goto(agentUrl)
  await expect(page.getByTestId('ask-reactivation')).toBeDisabled()
  for (const title of [reason, `${CODE} switched back on outside Control Tower`]) {
    await page.goto(agentUrl)
    const row = page.getByTestId('incident-row').filter({ hasText: title }).filter({ has: page.getByText('Open', { exact: true }) }).first()
    await row.getByTestId('incident-link').click()
    await page.getByLabel('Containment').fill('Agent suspended and blocked in Appian')
    await page.getByTestId('save-case').click()
    await expect(page.getByTestId('incident-log')).toContainText('Updated Containment')
    await page.getByTestId('mark-contained').click()
    await page.getByTestId('confirm-action').click()
    await expect(page.getByRole('button', { name: 'Back to open' })).toBeVisible()
  }
  await page.goto(agentUrl)

  // Task 4.9: the test agent has had incidents on earlier runs; repeats force a review before it can be asked back on.
  await expect(page.getByTestId('ask-reactivation')).toBeVisible()
  if (await page.getByTestId('reactivation-review-first').isVisible()) {
    await expect(page.getByTestId('ask-reactivation')).toBeDisabled()
    await page.getByRole('button', { name: 'Record review' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Save review' }).click()
    await expect(page.getByTestId('reactivation-review-first')).toHaveCount(0)
    console.log('[reactivation] review required first (repeat incidents); recorded')
  }

  await page.getByTestId('ask-reactivation').click()
  await page.getByRole('dialog').getByLabel('Reason').fill('Refund rules fixed and tested')
  await page.getByTestId('reactivation-confirm').click()
  await expect(page.getByTestId('reactivation-waiting')).toContainText('Refund rules fixed and tested')
  await expect(page.getByTestId('approve-reactivation')).toHaveCount(0) // the asker cannot approve
  await expect(page.getByTestId('suspension-done')).toBeVisible()      // still suspended

  // Ravi Menon (approver for Customer Service) approves from his Approvals page, in another browser.
  const ravi = await (await browser.newContext({ baseURL })).newPage()
  await signIn(ravi, 'ravi.menon')
  await ravi.getByRole('link', { name: 'Approvals' }).first().click()
  await ravi.getByTestId('reactivation-requests').getByRole('link', { name: `${CODE} Refund Processor` }).click()
  // Task 5.3: the task page that the approvers' emails link to. It lists the email to Ravi, and a decision needs a
  // sign-in: the same address opened signed out goes to the sign-in page.
  await expect(ravi).toHaveURL(/\/approvals\/reactivations\/[0-9a-f-]{36}$/)
  await expect(ravi.getByTestId('reactivation-task')).toHaveAttribute('data-status', 'pending')
  await expect(ravi.getByTestId('reactivation-told')).toContainText(/Email · Ravi Menon/)
  const signedOut = await (await browser.newContext({ baseURL })).newPage()
  await signedOut.goto(new URL(ravi.url()).pathname)
  await expect(signedOut.getByLabel('Password')).toBeVisible()
  await expect(signedOut.getByTestId('approve-reactivation')).toHaveCount(0)
  await signedOut.close()
  console.log('[reactivation-email] Ravi emailed a link to the task; signed out, the task asks for a sign-in')
  await ravi.getByTestId('approve-reactivation').click()
  const approved = Date.now()
  await ravi.getByTestId('reactivation-confirm').click()
  const back = ravi.getByTestId('restore-platform')
  await expect(back).toContainText('Switched back on at Northbridge Agent Platform (simulated) as NAP-001; read back as active', { timeout: 60_000 })
  const took2b = Date.now() - approved
  console.log(`[reactivation] switched back on in Appian and read back ${took2b} ms after approval`)
  await expect(ravi.getByTestId('reactivation-done')).toContainText('Approved by Ravi Menon')
  await expect(ravi.getByTestId('suspension-done')).toHaveCount(0)
  await ravi.close()
  expect(await appianStatus(request)).toBe('active')
  expect((await agentMayAct(request)).mayAct).toBe(true)
  story.push(`back on in Appian ${(took2b / 1000).toFixed(1)} s after Ravi's approval, and the agent may act again`)
  console.log(`[platform-story] ${story.join('; ')}`)
})
