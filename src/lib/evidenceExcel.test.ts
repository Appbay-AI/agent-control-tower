// @vitest-environment node
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { TABLES, type EvidencePack } from '@/lib/evidence'
import { buildEvidenceWorkbook, evidenceExcelName, HEADER_ROW } from '@/lib/evidenceExcel'
import { pdfText } from '@/test/evidencePdfText'
import { SAMPLE } from '@/test/evidenceSample'

// Task 6.2: the same evidence pack as Excel. Done when: the Excel matches the PDF. The workbook is written and read
// back as a real .xlsx file; every table holds the same rows and values as the PDF's, and every value printed in the
// PDF is in it.

async function roundTrip(p: EvidencePack) {
  const buf = await buildEvidenceWorkbook(p, ExcelJS).xlsx.writeBuffer()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as ArrayBuffer)
  return { wb, bytes: (buf as ArrayBuffer).byteLength }
}
const plain = (v: ExcelJS.CellValue) => (v instanceof Date ? v.getTime() : v ?? null)

describe('evidence pack as Excel (task 6.2)', () => {
  it('has a contents sheet, a sheet for every table in the PDF\'s order, and the attestation', async () => {
    const { wb, bytes } = await roundTrip(SAMPLE)
    expect(bytes).toBeGreaterThan(5_000)
    expect(evidenceExcelName(SAMPLE)).toBe('evidence-pack-2026-08-19-to-2026-11-17.xlsx')
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Contents', '1 Inventory', '2a Registrations', '2b Action requests', '3 Incidents', '4 Autonomy',
      '5 Reviews', '6a Suspensions', '6b Switch back on', '6c Stop or restore steps', '7 Drift', '8 Re-quarantine', '9a Sync by platform',
      '9b Sync failures and changes', '10 Attestation'])
    const cover = wb.getWorksheet('Contents')!
    expect(cover.getCell('A3').value).toBe('All dates and times are UTC. Produced 17 Nov 2026 09:14 UTC by Grace Auditor, Internal Audit Lead (Auditor). Recorded in the audit trail as entry #20511.')
    expect([2, 3, 4].map((c) => cover.getRow(8).getCell(c).value)).toEqual(['Approvals', 3002, '2a Registrations, 2b Action requests'])
  })

  it('every table matches the PDF\'s definition cell for cell, with real dates and numbers', async () => {
    const { wb } = await roundTrip(SAMPLE)
    for (const s of TABLES) for (const tb of s.tables) {
      const ws = wb.getWorksheet(tb.sheet)!
      const rows = tb.list(SAMPLE).rows
      expect(ws.getRow(HEADER_ROW).values, tb.sheet).toEqual([undefined, ...tb.cols.map((c) => c.head)])
      expect(ws.rowCount, tb.sheet).toBe(HEADER_ROW + rows.length)
      rows.forEach((r, ri) => tb.cols.forEach((c, ci) => {
        const want = c.cell(r)
        const got = ws.getCell(HEADER_ROW + 1 + ri, ci + 1)
        expect(plain(got.value), `${tb.sheet} ${c.head}`).toEqual(plain(want.value))
        if (want.numFmt && want.value != null) expect(got.numFmt, `${tb.sheet} ${c.head}`).toBe(want.numFmt)
      }))
    }
    const req = wb.getWorksheet('2b Action requests')!
    expect(req.getCell(HEADER_ROW + 1, 4)).toMatchObject({ value: 2000000, numFmt: '"£"#,##0' })
    expect(req.getCell(HEADER_ROW + 2, 4)).toMatchObject({ value: 5000, numFmt: '"US$"#,##0' })
    expect((req.getCell(HEADER_ROW + 1, 5).value as Date).toISOString()).toBe('2026-11-17T09:14:05.000Z')
    expect(req.getCell('A4').value).toBe('Showing the first 2 of 3,001 (each list stops at 2,000). Choose a shorter period to see them all. Not listed: 4 requests that expired because nobody decided in time, and 1 request refused automatically by the agent\'s limits.')
    const inv = wb.getWorksheet('1 Inventory')!
    expect(inv.getCell(HEADER_ROW + 2, 3)).toMatchObject({ value: 'No owner', font: { color: { argb: 'FFB91C1C' } } })
    expect(inv.autoFilter).toBeTruthy()
  })

  it('everything the PDF prints in its tables and attestation is in the Excel file', async () => {
    const [{ text }, { wb }] = await Promise.all([pdfText(SAMPLE), roundTrip(SAMPLE)])
    let checked = 0
    for (const s of TABLES) for (const tb of s.tables) for (const r of tb.list(SAMPLE).rows) for (const c of tb.cols) {
      const cell = c.cell(r)
      for (const line of cell.text.split('\n').filter(Boolean)) { expect(text, `${tb.sheet} ${c.head}`).toContain(line); checked++ }
    }
    expect(checked).toBeGreaterThan(100)
    const att = wb.getWorksheet('10 Attestation')!
    const attText = att.getSheetValues().flat().filter((v) => typeof v === 'string').join('\n')
    for (const s of ['entry #20511', 'all 20,511 entries'.replace('all ', ''), 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'Signature']) {
      expect(attText).toContain(s)
      expect(text).toContain(s)
    }
  }, 30_000)

  it('says so when the audit trail is broken, and when a table is empty', async () => {
    const broken: EvidencePack = { ...SAMPLE, drift: { total: 0, rows: [] }, attestation: { ...SAMPLE.attestation, chain_intact: false, chain_broken_at: 512 } }
    const { wb } = await roundTrip(broken)
    expect(wb.getWorksheet('Contents')!.getCell('A4').value).toMatch(/BROKEN at entry #512/)
    expect(wb.getWorksheet('10 Attestation')!.getCell('A2').value).toBe('Audit trail BROKEN')
    expect(wb.getWorksheet('7 Drift')!.getCell('A4').value).toBe('No changes outside the Control Tower were detected in this period.')
  })
})
