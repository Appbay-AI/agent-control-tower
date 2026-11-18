import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import ExcelJS from 'exceljs'

// Task 6.1 (R5.5): pick a date range, one click, a PDF. Done when: the PDF holds inventory, approvals, incidents,
// autonomy changes, reviews, kill-switch events, drift, sync history and an attestation. Mei Lin (auditor) makes the
// pack for the last 30 days on the work-in-progress site, and the PDF's own text is read back.
// Task 6.2: then the same pack as Excel. Done when: the Excel matches the PDF.

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
  await page.getByRole('link', { name: 'Reports' }).last().click()
  await page.getByRole('link', { name: /^Evidence pack/ }).click()
  await expect(page.getByRole('heading', { name: 'Evidence pack' })).toBeVisible()
  await page.getByRole('button', { name: 'Last 30 days' }).click()

  const started = Date.now()
  // If no file comes, say why: the error on the page, or how far it got (pack read from the database, PDF made).
  const why = async () => {
    const marks = await page.evaluate(() => Object.fromEntries(['act:evidence-start', 'act:evidence-data', 'act:evidence-file']
      .map((n) => [n.slice(13), Math.round(performance.getEntriesByName(n).at(-1)?.startTime ?? -1)])))
    const shown = await page.getByRole('alert').allTextContents().catch(() => [])
    return `no download after ${Date.now() - started} ms; on the page: ${shown.join(' / ') || 'no error'}; marks (ms since page load): ${JSON.stringify(marks)}`
  }
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 90_000 }).catch(async (e) => { throw new Error(`${await why()} (${(e as Error).message.split('\n')[0]})`) }),
    page.getByRole('button', { name: 'Download PDF' }).click()])
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
  console.log(`[evidence] ${info.project.name}: ${pages}-page PDF for the last 30 days, downloaded ${took} ms after the click, audit entry #${seq}, chain intact`)

  // Task 6.2: the same pack as Excel (same audit entry), and it matches the PDF.
  const xStarted = Date.now()
  const [xDownload] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), page.getByRole('button', { name: 'Download Excel' }).click()])
  const xTook = Date.now() - xStarted
  expect(xDownload.suggestedFilename()).toBe(download.suggestedFilename().replace(/\.pdf$/, '.xlsx'))
  await expect(made).toContainText(`Downloaded ${download.suggestedFilename()} and ${xDownload.suggestedFilename()}`)
  const xPath = info.outputPath('evidence.xlsx')
  await xDownload.saveAs(xPath)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(xPath)
  expect(wb.worksheets.map((w) => w.name)).toEqual(['Contents', '1 Inventory', '2a Registrations', '2b Action requests', '3 Incidents', '4 Autonomy',
    '5 Reviews', '6a Suspensions', '6b Switch back on', '6c Stop or restore steps', '7 Drift', '8 Re-quarantine', '9a Sync by platform',
    '9b Sync failures and changes', '10 Attestation'])
  const cover = wb.getWorksheet('Contents')!
  expect(String(cover.getCell('A3').value)).toContain(`Recorded in the audit trail as entry #${seq}.`)
  // The record count of every section is the same in both files.
  for (let i = 0; i < 10; i++) {
    const r = cover.getRow(7 + i)
    const title = String(r.getCell(2).value)
    const count = Number(r.getCell(3).value).toLocaleString('en-GB')
    expect(text, title).toContain(`${i + 1}. ${title} ${count}`)
  }
  // Every value in the first 25 rows of every table is printed in the PDF.
  let checked = 0
  for (const ws of wb.worksheets.slice(1, -1)) {
    for (let r = 6; r <= Math.min(ws.rowCount, 30); r++) {
      ws.getRow(r).eachCell((c) => {
        if (typeof c.value !== 'string') return
        for (const line of c.value.split('\n').filter((l) => l.trim())) { expect(text, `${ws.name} row ${r}`).toContain(line.replace(/\s+/g, ' ').trim()); checked++ }
      })
    }
  }
  expect(checked).toBeGreaterThan(100)
  const digest = (await page.getByText(/^SHA-256 of the pack's data:/).textContent())?.split(': ')[1]
  const att = wb.getWorksheet('10 Attestation')!.getSheetValues().flat().filter((v) => typeof v === 'string').join('\n')
  expect(att).toContain(digest!)
  expect(text).toContain(digest!)
  console.log(`[evidence-excel] ${info.project.name}: Excel of the same pack downloaded ${xTook} ms after the click, ${checked} values checked against the PDF`)
})
