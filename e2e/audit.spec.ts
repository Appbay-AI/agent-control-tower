import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

// Task 6.8: the audit view. Done when: any event can be found and exported. Mei Lin (auditor) opens it from Reports,
// finds an entry by its number and by its own words, narrows to one kind of record, exports what she found as CSV,
// and the file holds exactly those entries; the export itself is then found in the trail.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

test('any audit entry can be found and exported', async ({ page }, info) => {
  test.skip(!PASSWORD || info.project.name !== 'desktop', 'desktop menu only; DEMO_USER_PASSWORD is set by the e2e workflow')
  test.setTimeout(150_000)
  await page.goto('/login')
  await page.getByLabel('Email').fill('mei.lin@northbridge.demo')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
  await page.getByRole('link', { name: 'Reports' }).click()
  await page.getByRole('link', { name: /^Audit trail/ }).click()
  await expect(page.getByTestId('audit-table')).toBeVisible()
  const count = async () => Number((await page.getByTestId('audit-total').textContent())?.split(' ')[0].replace(/,/g, ''))

  // An entry from the middle of the latest page: found by its number, then by its own words.
  const row = page.getByTestId('audit-row').nth(5)
  const seq = await row.getAttribute('data-seq')
  const what = ((await row.locator('td').nth(4).textContent()) ?? '').replace(/Why:.*$/, '').trim()
  await page.getByLabel('Words').fill(`#${seq}`)
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('audit-total')).toHaveText('1 entry found')
  await expect(page.getByTestId('audit-row')).toHaveAttribute('data-seq', seq!)
  await page.getByTestId('audit-row').click()
  await expect(page.getByTestId('audit-detail')).toContainText('Hash ')
  await page.getByLabel('Words').fill(what.slice(0, 60))
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('audit-total')).not.toHaveText('0 entries found')
  await expect(async () => {
    if (await page.locator(`[data-testid="audit-row"][data-seq="${seq}"]`).count() === 0) await page.getByRole('button', { name: 'Show more' }).click()
    await expect(page.locator(`[data-testid="audit-row"][data-seq="${seq}"]`)).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 30_000 })

  // One kind of record (routing rules: a few hundred on this site), exported as CSV: every entry found is in the file.
  await page.getByLabel('Words').fill('')
  await page.getByLabel('Record').selectOption({ label: 'Routing rule' })
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('audit-row').first()).toBeVisible()
  const found = await count()
  expect(found).toBeGreaterThan(0)
  for (const cell of await page.getByTestId('audit-row').locator('td:nth-child(6)').allTextContents()) expect(cell).toBe('Routing rule')
  const first = await page.getByTestId('audit-row').first().getAttribute('data-seq')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()])
  const path = info.outputPath('audit.csv')
  await download.saveAs(path)
  const csv = await readFile(path, 'utf8')
  const lines = csv.split('\r\n').filter((l) => /^\d+,/.test(l))
  expect(csv.startsWith('Entry,When (UTC),Exact time (UTC),Actor type,Actor,Action,Record type')).toBe(true)
  expect(lines.length).toBeGreaterThanOrEqual(found) // entries written while exporting may join
  expect(lines.every((l) => l.split(',')[6] === 'Routing rule')).toBe(true)
  expect(lines.some((l) => l.startsWith(`${first},`))).toBe(true)

  // The export is on the record.
  const exportSeq = (await page.getByTestId('audit-exported').textContent())?.match(/entry #(\d+)/)?.[1]
  await page.getByLabel('Record').selectOption({ label: 'Any record' })
  await page.getByLabel('Words').fill(`#${exportSeq}`)
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('audit-row')).toContainText('Audit trail exported as CSV')
  console.log(`[audit] entry #${seq} found by number and by its words; ${found} routing-rule entries exported (${lines.length} lines); export recorded as #${exportSeq}`)
})
