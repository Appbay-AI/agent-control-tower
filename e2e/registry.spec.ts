import { expect, test, type Page } from '@playwright/test'

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
const as = (who: string) => `${who}@northbridge.demo`

async function signIn(page: Page, who: string, { goto = true } = {}) {
  if (goto) await page.goto('/login')
  await expect(page.getByLabel('Email')).toBeVisible()
  await page.getByLabel('Email').fill(as(who))
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test('the Chief Risk Officer sees the whole registry and the problems in it @phone', async ({ page }) => {
  await signIn(page, 'priya.sharma')
  // The story the demo opens with: owners missing, reviews overdue, approvals waiting.
  await expect(page.getByRole('button', { name: /No owner/ })).toContainText('6')
  await expect(page.getByRole('button', { name: /Review overdue/ })).toContainText('4')
  await page.getByRole('button', { name: /No owner/ }).click()
  await expect(page.getByText('Credit Memo Drafter').filter({ visible: true }).first()).toBeVisible()
})

test('a wrong password is refused', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill(as('priya.sharma'))
  await page.getByLabel('Password').fill('definitely-wrong-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Email or password is wrong.')).toBeVisible()
})

test('owners see only their own agents', async ({ page }) => {
  await signIn(page, 'lucy.grant')
  await expect(page.getByText('Chat Refund Agent').filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByText('Payment Release Assistant')).toHaveCount(0)
})

test('register → submit → approve → live, with segregation of duties and an audit trail', async ({ page }) => {
  const name = `E2E agent ${Date.now()}`

  // James proposes an agent and submits it.
  await signIn(page, 'james.whitfield')
  await page.getByRole('link', { name: 'Register agent' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Department').selectOption({ label: 'Payments' })
  await page.getByLabel('Purpose statement').fill('End-to-end test agent. Reads test data only.')
  await page.getByLabel('Systems it touches').fill('Test harness')
  await page.getByRole('button', { name: 'Save as Proposed' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
  await page.getByRole('button', { name: 'Submit for approval' }).click()
  await expect(page.getByText('Waiting for approval').first()).toBeVisible()
  // The owner is told whose queue it is in (Payments approvers, never the owner himself).
  await expect(page.getByText(/Can be approved by/)).toContainText('Daniel Okafor')
  await expect(page.getByText(/Can be approved by/)).toContainText('Ravi Menon')
  // He cannot approve his own agent: no decision buttons for him.
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  const agentUrl = page.url()
  await page.getByRole('button', { name: /sign out/i }).click()

  // Daniel signs in on the same browser straight after: he lands on the registry, not on James's page.
  await signIn(page, 'daniel.okafor', { goto: false })
  await page.getByRole('link', { name: 'Approvals' }).first().click()
  const card = page.locator('li').filter({ hasText: name })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Approve' }).click()
  await expect(card).toHaveCount(0)
  await page.getByRole('button', { name: /sign out/i }).click()

  // James puts it live; the audit trail shows each step and who did it.
  await signIn(page, 'james.whitfield')
  await page.goto(agentUrl)
  await page.getByRole('button', { name: 'Put live' }).click()
  await expect(page.getByText('Live', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/proposed → approved/)).toBeVisible()
  await expect(page.getByText(/approved → live/)).toBeVisible()
  await expect(page.getByText(/Daniel Okafor/).first()).toBeVisible()

  // Tidy up: retire it so the demo registry stays as seeded.
  await page.getByRole('button', { name: 'Retire' }).click()
  await page.getByLabel('Reason').fill('End-to-end test finished')
  await page.getByRole('button', { name: 'Retire agent' }).click()
  await expect(page.getByText('Retired', { exact: true }).first()).toBeVisible()
})

test('sending back needs a reason', async ({ page }) => {
  await signIn(page, 'daniel.okafor')
  await page.getByRole('link', { name: 'Approvals' }).first().click()
  const card = page.locator('li').filter({ hasText: 'Supplier Onboarding Bot' })
  await card.getByRole('button', { name: 'Send back' }).click()
  await card.getByRole('button', { name: 'Send back to owner' }).click()
  await expect(card.getByText('Say what needs to change.')).toBeVisible()
  await card.getByRole('button', { name: 'Cancel' }).click()
})

test("opening someone else's agent shows a plain message, never a raw error", async ({ page }) => {
  await signIn(page, 'lucy.grant')
  const href = await page.getByRole('link', { name: 'Chat Refund Agent' }).first().getAttribute('href')
  await page.getByRole('button', { name: /sign out/i }).click()
  // Daniel approves Payments and Treasury only, so he cannot see Lucy's Customer Service agent.
  await signIn(page, 'daniel.okafor', { goto: false })
  await page.goto(href!)
  await expect(page.getByText("This agent doesn't exist, or you don't have access to it.")).toBeVisible()
  await expect(page.getByText(/Cannot coerce/)).toHaveCount(0)
})
