import { expect, test } from '@playwright/test'

// Task 4.5: a whole incident case in the browser. An admin reports an incident on Invoice Matcher (owner James
// Whitfield), fills the case, marks it contained, then resolved, then reopens it with a reason.
// Task 4.9: resolved again, it is closed only by the named approver (Ravi Menon, an approver for Payments).

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

test('report an incident and work the case from Open to Resolved, then Closed by a named approver', async ({ page, browser, baseURL }) => {
  test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
  test.setTimeout(150_000)
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  await page.getByLabel('Search agents').fill('Invoice Matcher')
  await page.getByRole('link', { name: 'Invoice Matcher' }).first().click()

  const title = `E2E incident ${Date.now()}`
  await page.getByTestId('report-incident').click()
  await page.getByRole('dialog').getByLabel('Title').fill(title)
  await page.getByRole('dialog').getByLabel('Severity').selectOption('high')
  await page.getByTestId('report-incident-confirm').click()

  // The new case: owner and time to resolve (High = 1 day).
  await expect(page.getByTestId('incident-title')).toHaveText(title)
  await expect(page.getByTestId('incident-owner')).toHaveText('James Whitfield')
  await expect(page.getByTestId('incident-due')).toHaveText('Resolve within 1 day')
  await expect(page.getByTestId('mark-contained')).toBeDisabled()

  // Containment, then Contained.
  await page.getByLabel('Containment').fill('Matching paused; three invoices put on hold')
  await page.getByTestId('save-case').click()
  await expect(page.getByTestId('incident-log')).toContainText('Updated Containment')
  await page.getByTestId('mark-contained').click()
  await page.getByTestId('confirm-action').click()
  await expect(page.getByText('Contained', { exact: true }).first()).toBeVisible()

  // The rest of the case, then Resolved.
  await expect(page.getByTestId('mark-resolved')).toBeDisabled()
  await page.getByLabel('Impact').fill('Three invoices matched to the wrong purchase orders; no payment made')
  await page.getByLabel('Customers affected').fill('0')
  await page.getByLabel('Money involved (GBP)').fill('18250')
  await page.getByLabel('Personal data involved').selectOption('no')
  await page.getByLabel('Root cause category').selectOption('data_quality')
  await page.getByLabel('Root cause', { exact: true }).fill('Purchase order numbers were reused by a supplier')
  await page.getByLabel('Remediation').fill('Match on supplier and PO number together; supplier told')
  await page.getByLabel('Note for the log').fill('From the payments team')
  await page.getByTestId('save-case').click()
  await expect(page.getByTestId('incident-log')).toContainText('Updated Impact, Customers affected, Money involved')
  await page.getByTestId('mark-resolved').click()
  await page.getByTestId('confirm-action').click()
  await expect(page.getByTestId('reopen')).toBeVisible()
  await expect(page.getByTestId('incident-due')).toHaveCount(0) // a resolved case has no time left

  // Reopening needs a reason.
  await page.getByTestId('reopen').click()
  await expect(page.getByTestId('confirm-action')).toBeDisabled()
  await page.getByRole('dialog').getByLabel('Reason').fill('A fourth invoice found')
  await page.getByTestId('confirm-action').click()
  await expect(page.getByTestId('incident-log')).toContainText('Open: A fourth invoice found')
  console.log(`[incident-case] ${title}: reported, contained, resolved and reopened`)

  // Task 4.9: resolved again; closing needs a named approver, and only they can close it.
  await page.getByTestId('mark-resolved').click()
  await page.getByTestId('confirm-action').click()
  await page.getByTestId('ask-close').click()
  await expect(page.getByTestId('confirm-closure')).toBeDisabled()
  const approver = page.getByRole('dialog').getByLabel('Approver')
  await expect(approver.locator('option', { hasText: 'Ravi Menon' })).toHaveCount(1)
  await expect(approver.locator('option', { hasText: 'Platform Admin' })).toHaveCount(0) // not the asker
  await approver.selectOption({ label: (await approver.locator('option', { hasText: 'Ravi Menon' }).textContent())! })
  await page.getByRole('dialog').getByLabel('Note').fill('Fix confirmed with the payments team')
  await page.getByTestId('confirm-closure').click()
  await expect(page.getByTestId('closure-waiting')).toContainText('Waiting for Ravi Menon to approve closing')
  await expect(page.getByTestId('approve-close')).toHaveCount(0)
  const url = page.url()

  const ctx = await browser.newContext({ baseURL })
  const ravi = await ctx.newPage()
  await ravi.goto('/login')
  await ravi.getByLabel('Email').fill('ravi.menon@northbridge.demo')
  await ravi.getByLabel('Password').fill(PASSWORD)
  await ravi.getByRole('button', { name: 'Sign in' }).click()
  await expect(ravi.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  await ravi.goto('/approvals')
  await ravi.getByTestId('incident-closures').getByRole('link', { name: new RegExp(title) }).click()
  await ravi.getByTestId('approve-close').click()
  await ravi.getByTestId('confirm-closure').click()
  await expect(ravi.getByTestId('closure-done')).toContainText('approved by Ravi Menon')
  await ctx.close()
  await page.goto(url)
  await expect(page.getByTestId('incident-log')).toContainText('Closed: approved by Ravi Menon')
  await expect(page.getByTestId('incident-actions')).toHaveCount(0) // a closed case cannot be changed
  console.log(`[incident-case] ${title}: closed by the named approver (Ravi Menon)`)
})
