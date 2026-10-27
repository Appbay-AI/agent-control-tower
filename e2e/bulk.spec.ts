import { expect, test, type Page } from '@playwright/test'

// Task 2.10: bulk approval. The Branch Rota Planner (low risk) asks three times; Omar Farouk, its approver, selects the
// three on the Approvals screen and approves them in one go. Each is approved on its own, and each agent request says so.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''
// A key for the Branch Rota Planner, made by the e2e workflow for this run and revoked after it.
const LOW_KEY = process.env.ACT_LOW_AGENT_KEY ?? ''

async function signIn(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(`${who}@northbridge.demo`)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

test('an approver approves several low-risk requests at once; each is decided and the agent is told', async ({ page, request }) => {
  test.skip(!LOW_KEY, 'ACT_LOW_AGENT_KEY is set by the e2e workflow')
  const stamp = `E2E ${Date.now()}`
  const codes: string[] = []
  for (const branch of ['A', 'B', 'C']) {
    const asked = await request.post('/api/v1/actions/request', {
      headers: { authorization: `Bearer ${LOW_KEY}`, 'idempotency-key': `${stamp} ${branch}` },
      data: { action: 'rota.publish', description: `Publish next week's staff rota for the ${stamp} ${branch} branch`,
        reasoning: 'All shifts covered', details: { test: true } },
    })
    expect(asked.status()).toBe(201)
    const body = await asked.json()
    expect(body.status).toBe('pending')
    codes.push(body.request_code)
  }

  await signIn(page, 'omar.farouk')
  await page.getByRole('link', { name: 'Approvals' }).first().click()
  for (const code of codes) await page.getByLabel(`Select ${code}`).check()
  await page.getByRole('button', { name: 'Approve selected (3)' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading')).toHaveText('Approve 3 low-risk requests?')
  await dialog.getByLabel('Note (optional)').fill('Rotas checked')
  await dialog.getByRole('button', { name: 'Approve 3' }).click()
  await expect(page.getByTestId('bulk-result')).toHaveText('3 approved.')
  for (const code of codes) await expect(page.getByLabel(`Select ${code}`)).toHaveCount(0)

  for (const code of codes) {
    const answer = await (await request.get(`/api/v1/actions/${code}`, { headers: { authorization: `Bearer ${LOW_KEY}` } })).json()
    expect(answer).toMatchObject({ status: 'approved', may_proceed: true, decision_source: 'human',
      reason: 'Approved by Omar Farouk: Bulk approval: Rotas checked' })
  }
})
