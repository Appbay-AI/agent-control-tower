import { expect, test } from '@playwright/test'

// Task 6.7 (R5.4): the personal-data access mismatch report. Done when: mismatches are listed with roles. Mei Lin
// (auditor) opens it from Reports: every mismatch shows the person's role and the roles that may see the data, and
// each one is the same person flagged on the agent's own Access list (from the data-authority check, task 4.8).

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

test('the data access mismatch report lists each mismatch with roles, as on the agents\' own pages', async ({ page }, info) => {
  test.skip(!PASSWORD || info.project.name !== 'desktop', 'desktop menu only; DEMO_USER_PASSWORD is set by the e2e workflow')
  test.setTimeout(120_000)
  await page.goto('/login')
  await page.getByLabel('Email').fill('mei.lin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  await page.getByRole('link', { name: 'Reports' }).click()
  await page.getByRole('link', { name: /^Data access mismatches/ }).click()
  await expect(page.getByTestId('data-access')).toBeVisible()

  for (const scope of ['Personal data', 'All sensitive data']) {
    await page.getByRole('button', { name: scope }).click()
    await expect(page.getByRole('button', { name: scope })).toHaveAttribute('aria-pressed', 'true')
    const total = Number(await page.getByTestId('mm-total').textContent())
    if (total === 0) { await expect(page.getByTestId('mm-none')).toBeVisible(); continue }
    const rows = page.getByTestId('mm-row')
    await expect(rows).toHaveCount(total)
    // With roles: the person's role (or "No job title"), their Control Tower standing, and who may see the data.
    for (let i = 0; i < total; i++) {
      await expect(rows.nth(i).getByTestId('mm-role')).not.toBeEmpty()
      await expect(rows.nth(i).getByTestId('mm-ct')).not.toBeEmpty()
      await expect(rows.nth(i).getByTestId('mm-authorised')).not.toBeEmpty()
    }
    // The roles table adds up to the total.
    const byRole = (await page.getByTestId('mm-roles').locator('tbody tr td:nth-child(2)').allTextContents()).map(Number)
    expect(byRole.reduce((a, b) => a + b, 0)).toBe(total)
  }

  // The first mismatch is the same person flagged on that agent's own Access list.
  await page.getByRole('button', { name: 'Personal data' }).click()
  const first = page.getByTestId('mm-row').first()
  if (await first.count()) {
    const name = (await first.locator('td').first().locator('div').first().textContent()) ?? ''
    const role = (await first.getByTestId('mm-role').textContent()) ?? ''
    await first.getByRole('link').click()
    const person = page.getByTestId('access-person').filter({ hasText: name })
    await expect(person).toHaveAttribute('data-ok', 'false')
    await expect(person.getByTestId('access-missing')).toContainText(/Personal/)
    console.log(`[data-access] ${name} (${role}) flagged on the agent's page too`)
  } else {
    console.log('[data-access] no personal-data mismatches on this site')
  }
})
