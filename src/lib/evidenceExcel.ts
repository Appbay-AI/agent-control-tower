// Task 6.2: the same evidence pack as an Excel file. Built from the same table definitions as the PDF (TABLES in
// evidence.ts), so every row and value matches; dates and numbers are real Excel dates and numbers, shown with the
// same formatting as the PDF, and every table has filters and a frozen header.
import type { Workbook, Worksheet } from 'exceljs'
import { attestation, cutNote, day, noneText, packAgent, producedBy, SECTIONS, sectionCounts, TABLES, when, type Cell, type EvidencePack } from '@/lib/evidence'

type ExcelModule = { Workbook: new () => Workbook }

const RED = 'FFB91C1C'
const GREY = 'FF475569'
const HEAD_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFE2E8F0' } }
/** The row each table's header sits on, on every sheet (title, count, about, note above it). */
export const HEADER_ROW = 5

export const evidenceExcelName = (p: Pick<EvidencePack, 'period' | 'agent'>) => `evidence-pack-${p.agent ? `${p.agent.code}-` : ''}${p.period.from}-to-${p.period.to}.xlsx`

function title(ws: Worksheet, text: string, sub: string, about: string, note: string | null) {
  ws.getCell('A1').value = text
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.getCell('A2').value = sub
  ws.getCell('A2').font = { size: 11, color: { argb: GREY } }
  ws.getCell('A3').value = about
  ws.getCell('A3').font = { italic: true, color: { argb: GREY } }
  if (note) {
    ws.getCell('A4').value = note
    ws.getCell('A4').font = { italic: true, color: { argb: 'FFB45309' } }
  }
}

function put(ws: Worksheet, row: number, col: number, c: Cell) {
  const cell = ws.getCell(row, col)
  cell.value = c.value
  if (c.numFmt && c.value != null) cell.numFmt = c.numFmt
  if (c.red || c.bold) cell.font = { ...(c.red ? { color: { argb: RED } } : {}), ...(c.bold ? { bold: true } : {}) }
  if (c.kind === 'text' && typeof c.value === 'string' && (c.value.length > 40 || c.value.includes('\n'))) cell.alignment = { wrapText: true, vertical: 'top' }
  else cell.alignment = { vertical: 'top' }
}

export function buildEvidenceWorkbook(p: EvidencePack, Excel: ExcelModule): Workbook {
  const wb = new Excel.Workbook()
  wb.creator = 'Agent Control Tower'
  wb.title = `Evidence pack ${p.agent ? `${p.agent.code} ` : ''}${p.period.from} to ${p.period.to}`
  wb.created = new Date(p.generated.at)
  const a = p.attestation
  const range = `${day(p.period.from)} to ${day(p.period.to)}`
  const counts = sectionCounts(p)

  // Contents: the same cover as the PDF, with the sheet each section is on.
  const cover = wb.addWorksheet('Contents', { views: [{ showGridLines: false }] })
  cover.columns = [{ width: 6 }, { width: 30 }, { width: 14 }, { width: 70 }]
  cover.getCell('A1').value = 'Agent Control Tower: Evidence pack'
  cover.getCell('A1').font = { bold: true, size: 18 }
  cover.getCell('A2').value = packAgent(p) ? `${range} · Agent ${packAgent(p)} only` : range
  cover.getCell('A2').font = { size: 13 }
  cover.getCell('A3').value = `All dates and times are UTC. Produced ${when(p.generated.at)} UTC by ${producedBy(p)}. Recorded in the audit trail as entry #${a.pack_seq}.`
  cover.getCell('A3').font = { color: { argb: GREY } }
  cover.getCell('A4').value = a.chain_intact
    ? `Audit trail checked when this pack was produced: all ${a.chain_length.toLocaleString('en-GB')} entries intact.`
    : `Audit trail checked when this pack was produced: BROKEN at entry #${a.chain_broken_at}. See the Attestation sheet.`
  cover.getCell('A4').font = { bold: true, color: { argb: a.chain_intact ? 'FF047857' : RED } }
  const head = cover.getRow(6)
  head.values = ['#', 'Section', 'Records', 'Sheets']
  head.font = { bold: true }
  head.eachCell((c) => { c.fill = HEAD_FILL })
  SECTIONS.forEach(([k, name], i) => {
    const sheets = k === 'attestation' ? ['10 Attestation'] : TABLES.find((s) => s.key === k)!.tables.map((tb) => tb.sheet)
    const r = cover.getRow(7 + i)
    r.values = [i + 1, name, counts[k], sheets.join(', ')]
    r.getCell(3).numFmt = '#,##0'
  })

  // One sheet per table, in the PDF's order.
  TABLES.forEach((s, i) => {
    for (const tb of s.tables) {
      const list = tb.list(p)
      const ws = wb.addWorksheet(tb.sheet, { views: [{ state: 'frozen', ySplit: HEADER_ROW }] })
      ws.columns = tb.cols.map((c) => ({ width: c.xl }))
      const notes = [cutNote(list, p.cap), tb.note?.(p) ?? null, list.total === 0 ? noneText(tb, p) : null].filter(Boolean).join(' ')
      title(ws, `${i + 1}. ${s.title}${tb.heading ? `: ${tb.heading}` : ''}`, s.count(p), s.about, notes || null)
      const h = ws.getRow(HEADER_ROW)
      h.values = tb.cols.map((c) => c.head)
      h.font = { bold: true }
      h.eachCell((c) => { c.fill = HEAD_FILL; c.alignment = { vertical: 'top', wrapText: true } })
      list.rows.forEach((r, ri) => tb.cols.forEach((c, ci) => put(ws, HEADER_ROW + 1 + ri, ci + 1, c.cell(r))))
      if (list.rows.length > 0) ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW + list.rows.length, column: tb.cols.length } }
    }
  })

  // Attestation: the same words and facts as the PDF, and the place to sign.
  const at = attestation(p)
  const ws = wb.addWorksheet('10 Attestation', { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 36 }, { width: 100 }]
  ws.getCell('A1').value = '10. Attestation'
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.getCell('A2').value = a.chain_intact ? 'Audit trail intact' : 'Audit trail BROKEN'
  ws.getCell('A2').font = { bold: true, color: { argb: a.chain_intact ? 'FF047857' : RED } }
  ;[at.intro, at.rule, at.result].forEach((text, i) => {
    const r = 4 + i
    ws.mergeCells(r, 1, r, 2)
    const c = ws.getCell(r, 1)
    c.value = text
    c.alignment = { wrapText: true, vertical: 'top' }
    if (i === 2 && at.broken) c.font = { bold: true, color: { argb: RED } }
    ws.getRow(r).height = 32
  })
  at.facts.forEach(([k, v], i) => {
    const r = ws.getRow(8 + i)
    r.values = [k, v]
    r.getCell(1).font = { bold: true }
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' }
    if (k === 'Chain checked' && at.broken) r.getCell(2).font = { bold: true, color: { argb: RED } }
    if (v.includes('\n')) r.height = 30
  })
  const signAt = 8 + at.facts.length + 1
  ws.getCell(signAt, 1).value = 'Attested by'
  ws.getCell(signAt, 1).font = { bold: true, size: 12 }
  at.sign.forEach((k, i) => {
    const r = ws.getRow(signAt + 1 + i)
    r.values = [k, '']
    r.height = 28
    r.getCell(1).font = { bold: true }
    r.getCell(2).border = { bottom: { style: 'thin', color: { argb: 'FF94A3B8' } } }
  })
  return wb
}

/** Makes the Excel file in the browser and saves it. ExcelJS loads only when someone asks for one. */
export async function downloadEvidenceExcel(p: EvidencePack): Promise<void> {
  const mod = (await import('exceljs')) as unknown as ExcelModule & { default?: ExcelModule }
  const buf = await buildEvidenceWorkbook(p, mod.default ?? mod).xlsx.writeBuffer()
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: evidenceExcelName(p) })
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
