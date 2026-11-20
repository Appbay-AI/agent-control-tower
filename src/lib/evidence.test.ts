// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { day, evidenceFileName, fixedWidth, PAGE_WIDTH, sectionCounts, TABLES, when, type EvidencePack } from '@/lib/evidence'
import { pdfText } from '@/test/evidencePdfText'
import { SAMPLE } from '@/test/evidenceSample'
import { quickRanges } from '@/pages/EvidencePage'

// Task 6.1 (R5.5). Done when: the PDF holds inventory, approvals, incidents, autonomy changes, reviews, kill-switch
// events, drift, sync history and an attestation. This prints a real PDF from a sample pack and reads its text back.

describe('evidence pack PDF (task 6.1)', () => {
  it('formats dates in UTC whatever the reader\'s time zone', () => {
    expect(day('2026-11-17')).toBe('17 Nov 2026')
    expect(when('2026-11-17T23:59:00+05:30')).toBe('17 Nov 2026 18:29')
    expect(when(null)).toBe('')
    expect(evidenceFileName(SAMPLE)).toBe('evidence-pack-2026-08-19-to-2026-11-17.pdf')
  })

  it('counts each section', () => {
    expect(sectionCounts(SAMPLE)).toEqual({ inventory: 2, approvals: 3002, incidents: 1, autonomy: 1, reviews: 1, killswitch: 3, drift: 1,
      requarantine: 1, sync: 4332, attestation: 9000 })
  })

  it('offers quick ranges ending today, and last quarter in full', () => {
    const r = quickRanges(new Date('2026-11-17T10:00:00Z'))
    expect(r.map((x) => [x.label, x.from, x.to])).toEqual([
      ['Last 30 days', '2026-10-19', '2026-11-17'], ['Last 90 days', '2026-08-20', '2026-11-17'],
      ['Q3 2026', '2026-07-01', '2026-09-30'], ['2026 so far', '2026-01-01', '2026-11-17']])
    expect(quickRanges(new Date('2026-02-01T00:00:00Z'))[2]).toMatchObject({ label: 'Q4 2025', from: '2025-10-01', to: '2025-12-31' })
  })

  it('prints every section, the records in it, and the attestation', async () => {
    const { text, pages, bytes } = await pdfText(SAMPLE)
    expect(bytes).toBeGreaterThan(10_000)
    expect(pages).toBeGreaterThanOrEqual(11) // cover, then each section from a new page
    for (const s of ['Evidence pack', '19 Aug 2026 to 17 Nov 2026', '1. Agent inventory', '2. Approvals', '3. Incidents', '4. Autonomy changes', '5. Reviews',
      '6. Kill-switch events', '7. Drift', '8. Re-quarantine actions', '9. Sync history', '10. Attestation']) expect(text).toContain(s)
    // A record from each section.
    for (const s of ['AGT-0001 Payment Release Assistant', 'James Whitfield', 'Ravi Menon: Approve', 'REQ-000123', 'Ravi Menon, Daniel Okafor',
      'INC-0007', 'Paid twice', 'Level 1', 'Level 2', 'Quarterly check', 'Released a payment twice', 'Fixed the duplicate check',
      'Blocked; read back as blocked', 'Switched on outside', 'Blocked again; read back as blocked', 'Appian did not answer', '4,320']) expect(text).toContain(s)
    // Lists cut at the cap say so; expired and refused requests are counted.
    expect(text).toContain('Showing the first 2 of 3,001')
    expect(text).toContain('4 requests that expired')
    // Attestation: who, when, the audit entry, the chain, the hashes and the digest, and a place to sign.
    for (const s of ['Grace Auditor, Internal Audit Lead (Auditor)', 'audit trail as entry #20511', 'all 20,511 entries intact', '#11000', '#20510',
      'b'.repeat(64), 'c'.repeat(64), 'a'.repeat(64), 'Attested by', 'Signature']) expect(text).toContain(s)
  }, 30_000)

  it('says plainly when the audit trail is broken, and when a section is empty', async () => {
    const empty = { total: 0, rows: [] }
    const broken: EvidencePack = { ...SAMPLE, drift: empty, attestation: { ...SAMPLE.attestation, chain_intact: false, chain_broken_at: 512 } }
    const { text } = await pdfText(broken)
    expect(text).toContain('BROKEN at entry #512')
    expect(text).toContain('No changes outside the Control Tower were detected in this period.')
  }, 30_000)

  // 20 Nov: a pack for one agent names it on the cover, in the attestation and in the file name.
  it('a pack for one agent says which agent, on the cover and in the file name', async () => {
    const one: EvidencePack = { ...SAMPLE, agent: { id: 'a1', code: 'AGT-0001', name: 'Payment Release Assistant' }, sync: { ...SAMPLE.sync, platforms: [] } }
    expect(evidenceFileName(one)).toBe('evidence-pack-AGT-0001-2026-08-19-to-2026-11-17.pdf')
    const { text } = await pdfText(one)
    for (const s of ['Agent: AGT-0001 Payment Release Assistant', 'This pack covers this one agent only', 'Audit entries for AGT-0001 in the period',
      'This agent is not on a connected agent platform.']) expect(text).toContain(s)
    expect((await pdfText(SAMPLE)).text).not.toContain('This pack covers this one agent only')
  }, 30_000)

  it('every table fits the page, leaving its stretchy column room', () => {
    for (const sec of TABLES) for (const tb of sec.tables) {
      expect(fixedWidth(tb.cols) + (tb.cols.some((c) => c.pdf === '*') ? 60 : 0), tb.sheet).toBeLessThanOrEqual(PAGE_WIDTH)
    }
  })

  it('a very long word in one column does not push the last column off the page (seen on the test site, 17 Nov)', async () => {
    const long = '51 incidents in 90 days (' + Array.from({ length: 51 }, (_, i) => `INC-${String(29 + i * 5).padStart(4, '0')}`).join(', ') + ')'
    const rows = [{ ...SAMPLE.inventory.rows[0], name: 'E2E-register-1794904378558-abcdefghijkl' }, { ...SAMPLE.inventory.rows[1], review_required: long }]
    const { text } = await pdfText({ ...SAMPLE, inventory: { total: 2, rows } })
    expect(text).toContain(long)
    expect(text).toContain('E2E-register-1794904378558-abcdefghijkl')
  }, 30_000)
})
