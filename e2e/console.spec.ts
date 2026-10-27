import { expect, test, type Page } from '@playwright/test'

// Task 2.8: the decision goes back to the agent. The agent console (admin) asks as the Payment Release Assistant
// with a callback address; Ravi and then Daniel approve in other browsers (four-eyes); the Control Tower calls the agent back with a signed
// decision; the console shows the signature checked and the agent going ahead. Test mode: no alerts or emails to people.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

async function signIn(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

test('the demo agent asks, a person approves, and the agent hears the signed decision and goes ahead', async ({ page, browser, baseURL }, info) => {
  test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
  const stamp = `E2E ${Date.now()}`

  // The admin's console: the agent asks to release £2m.
  await signIn(page, 'admin')
  await page.goto('/demo/agent?test=1')
  await page.getByLabel('Supplier').fill(stamp)
  await page.getByRole('button', { name: 'Ask the Control Tower' }).click()
  const run = page.getByTestId('console-run').filter({ hasText: stamp })
  await expect(run.getByTestId('console-step-waiting')).toBeVisible()
  const code = (await run.getByRole('link').textContent())!.trim()
  expect(code).toMatch(/^REQ-\d{6}$/)

  // Ravi, in another browser, approves it.
  const ravi = await (await browser.newContext({ baseURL })).newPage()
  await signIn(ravi, 'ravi.menon')
  await ravi.getByRole('link', { name: 'Approvals' }).first().click()
  await ravi.getByTestId('request-card').filter({ hasText: stamp }).click()
  await expect(ravi.getByTestId('request-headline')).toContainText(stamp)
  await ravi.getByRole('button', { name: 'Approve' }).click()
  await ravi.getByLabel('Note (optional)').fill('Supplier verified')
  await ravi.getByRole('button', { name: 'Confirm approval' }).click()
  // Four-eyes (task 2.10): the agent is Critical, so Daniel must approve too. The agent keeps waiting meanwhile.
  await expect(ravi.getByTestId('four-eyes-status')).toContainText('1 of 2 so far')
  await expect(run.getByTestId('console-step-waiting')).toBeVisible()
  const daniel = await (await browser.newContext({ baseURL })).newPage()
  await signIn(daniel, 'daniel.okafor')
  await daniel.goto(`/approvals/requests/${ravi.url().split('/').pop()}`)
  await expect(daniel.getByTestId('request-headline')).toContainText(stamp)
  await daniel.getByRole('button', { name: 'Approve' }).click()
  await daniel.getByLabel('Note (optional)').fill('Second check done')
  const decidedAt = Date.now() // the final approval
  await daniel.getByRole('button', { name: 'Confirm approval' }).click()
  await expect(daniel.getByTestId('request-outcome')).toHaveText('Approved by Ravi Menon (Supplier verified) and Daniel Okafor (Second check done)')
  await daniel.context().close()

  // The agent hears it (signature checked) and goes ahead, without anyone touching the console.
  await expect(run.getByTestId('console-step-heard')).toContainText('signature checked: Approved by Ravi Menon (Supplier verified) and Daniel Okafor (Second check done)', { timeout: 30_000 })
  await expect(run.getByTestId('console-step-acted')).toContainText(`Going ahead: releasing £2,000,000 to supplier ${stamp} (simulated).`)
  const took = Date.now() - decidedAt
  console.log(`[callback] agent heard the decision ${took} ms after the approval`)
  info.annotations.push({ type: 'callback', description: `${took} ms` })

  // The request page lists the callback as delivered.
  await ravi.reload()
  await expect(ravi.getByTestId('who-was-told').locator('li').filter({ hasText: 'Callback to agent' })).toContainText('Delivered (HTTP 200)')
  await ravi.context().close()
})
