import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

// Task 6.1 (R5.5): pick a date range, one click, a PDF. Done when: the PDF holds inventory, approvals, incidents,
// autonomy changes, reviews, kill-switch events, drift, sync history and an attestation. Mei Lin (auditor) makes the
// pack for the last 30 days on the work-in-progress site, and the PDF's own text is read back.

const PASSWORD = process.env.DEMO_USER_PASSWORD ?? ''

async function pdfText(path: string): Promise<{ text: string; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: false }).promise
  let text = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    text += (await page.getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n'
  }
  return { text: text.replace(/\s+/g, ' ').replace(/(\w)- (\w)/g, '$1-$2'), pages: doc.numPages }
}

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Agent registry' })).toBeVisible()
}

test('an auditor picks a date range and downloads the evidence pack as a PDF, with every section @phone', async ({ page }, info) => {
  test.skip(!PASSWORD, 'DEMO_USER_PASSWORD is set by the e2e workflow')
  test.setTimeout(120_000)
  await signIn(page, 'mei.lin@northbridge.demo')
  await page.getByRole('link', { name: 'Evidence' }).last().click()
  await expect(page.getByRole('heading', { name: 'Evidence pack' })).toBeVisible()
  await page.getByRole('button', { name: 'Last 30 days' }).click()

  const started = Date.now()
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), page.getByRole('button', { name: 'Download PDF' }).click()])
  const took = Date.now() - started
  expect(download.suggestedFilename()).toMatch(/^evidence-pack-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.pdf$/)
  const made = page.getByTestId('evidence-made')
  await expect(made).toContainText('recorded in the audit trail as entry #')
  await expect(page.getByTestId('evidence-chain')).toContainText('Audit trail intact')

  const path = info.outputPath('evidence.pdf')
  await download.saveAs(path)
  const { text, pages } = await pdfText(path)
  for (const s of ['Evidence pack', '1. Agent inventory', '2. Approvals', '3. Incidents', '4. Autonomy changes', '5. Reviews', '6. Kill-switch events',
    '7. Drift', '8. Re-quarantine actions', '9. Sync history', '10. Attestation', 'Mei Lin', 'Attested by']) expect(text, s).toContain(s)
  // Records the test runs themselves leave behind on this site: the registry's demo agents, the kill switch test's
  // suspensions of the Mail Room Router, the Appian simulator's syncs and the audit trail checked intact.
  for (const s of ['AGT-0001 Payment Release Assistant', 'Mail Room Router', 'Northbridge Agent Platform (simulated)', 'entries intact']) expect(text, s).toContain(s)
  const seq = (await made.textContent())?.match(/entry #(\d+)/)?.[1]
  expect(text).toContain(`audit trail as entry #${seq}`)
  console.log(`[evidence] ${info.project.name}: ${pages}-page PDF for the last 30 days, downloaded ${took} ms after the click; audit entry #${seq}, chain intact`)
})
