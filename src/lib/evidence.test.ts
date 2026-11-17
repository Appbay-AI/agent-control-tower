// @vitest-environment node
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { buildEvidenceDoc, day, evidenceFileName, sectionCounts, when, type EvidencePack } from '@/lib/evidence'
import { quickRanges } from '@/pages/EvidencePage'

// Task 6.1 (R5.5). Done when: the PDF holds inventory, approvals, incidents, autonomy changes, reviews, kill-switch
// events, drift, sync history and an attestation. This prints a real PDF from a sample pack and reads its text back.

const at = '2026-11-17T09:14:05Z'
const list = (rows: Record<string, unknown>[], total = rows.length) => ({ total, rows })
export const SAMPLE: EvidencePack = {
  period: { from: '2026-08-19', to: '2026-11-17', timezone: 'UTC' },
  generated: { at, by: 'Grace Auditor', email: 'grace@bank.test', job_title: 'Internal Audit Lead', roles: ['auditor'] },
  cap: 2000,
  inventory: list([{ code: 'AGT-0001', name: 'Payment Release Assistant', department: 'Payments', business_owner: 'James Whitfield', technical_owner: null,
    risk_tier: 'critical', autonomy_level: 2, status: 'suspended', source: 'Manual', data: ['personal'], approved_at: at, next_review: '2027-05-17', review_required: null }]),
  registrations: list([{ agent: 'AGT-0001 Payment Release Assistant', submitted_at: at, decided_at: at, outcome: 'approved', required: 2,
    decisions: [{ by: 'Ravi Menon', decision: 'approve', reason: 'Limits are right', at }, { by: 'Daniel Okafor', decision: 'approve', reason: null, at }] }]),
  requests: { ...list([{ code: 'REQ-000123', agent: 'AGT-0001 Payment Release Assistant', action: 'Release payment', amount: 2000000, currency: 'GBP',
    requested_at: at, decided_at: at, outcome: 'approved', approvers: ['Ravi Menon', 'Daniel Okafor'], reason: 'Approved by both' }], 3001), expired: 4, refused: 1 },
  incidents: list([{ code: 'INC-0007', agent: 'AGT-0001 Payment Release Assistant', severity: 'critical', status: 'contained', title: 'Paid twice',
    source: 'suspension', owner: 'Tom Becker', opened_at: at, due_at: at, closed_at: null }]),
  autonomy: list([{ seq: 412, at, agent: 'AGT-0001 Payment Release Assistant', from: 1, to: 2, by: 'James Whitfield', reason: null }]),
  reviews: list([{ agent: 'AGT-0001 Payment Release Assistant', at, by: 'Ravi Menon', outcome: 'no_change', notes: 'Quarterly check', next: '2027-05-17' }]),
  suspensions: list([{ agent: 'AGT-0001 Payment Release Assistant', status: 'done', reason: 'Released a payment twice', requested_by: 'Platform Admin',
    requested_at: at, confirmed_by: null, suspended_at: at, withdrawn_at: null }]),
  reactivations: list([{ agent: 'AGT-0001 Payment Release Assistant', status: 'approved', reason: 'Fixed the duplicate check', requested_by: 'James Whitfield',
    requested_at: at, decided_at: at, decision_reason: null, approvers: ['Ravi Menon', 'Daniel Okafor'] }]),
  enforcement: list([{ id: 9, agent: 'AGT-0001 Payment Release Assistant', action: 'stop', cause: 'suspension', method: 'platform',
    target: 'Northbridge Agent Platform (simulated) as NAP-001', status: 'done', attempts: 1, detail: 'Blocked; read back as blocked', created_at: at, finished_at: at }]),
  drift: list([{ agent: 'AGT-0001 Payment Release Assistant', at, kind: 'switched_on_outside', expected: 'Blocked', observed: 'Active',
    actor: 'Unknown, outside Control Tower', action: 'Blocked again', result: 'Read back as blocked', incident: 'INC-0008' }]),
  requarantine: list([{ id: 10, agent: 'AGT-0001 Payment Release Assistant', target: 'Northbridge Agent Platform (simulated) as NAP-001', status: 'done',
    attempts: 1, detail: 'Blocked again; read back as blocked', created_at: at, finished_at: at }]),
  sync: { ...list([{ id: 1, platform: 'Northbridge Agent Platform (simulated)', kind: 'sync', at, ok: false, message: 'Appian did not answer' }]),
    platforms: [{ name: 'Northbridge Agent Platform (simulated)', kind: 'appian_simulator', every_minutes: 30, syncs: 4320, failed: 1, reconciliations: 12, last_sync: at, agents: 8 }] },
  attestation: { pack_seq: 20511, digest: 'a'.repeat(64), chain_intact: true, chain_broken_at: null, chain_length: 20511, period_events: 9000,
    period_first: { seq: 11000, at, hash: 'b'.repeat(64) }, period_last: { seq: 20510, at, hash: 'c'.repeat(64) }, latest_hash: 'd'.repeat(64) },
}

async function pdfText(pack: EvidencePack): Promise<{ text: string; pages: number; bytes: number }> {
  const require = createRequire(import.meta.url)
  const pdfmake = require('pdfmake') // the Node build
  pdfmake.setFonts(require('pdfmake/fonts/Roboto.js'))
  const buf: Buffer = await pdfmake.createPdf(buildEvidenceDoc(pack)).getBuffer()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false }).promise
  let text = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    text += (await page.getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n'
  }
  return { text: text.replace(/\s+/g, ' ').replace(/(\w)- (\w)/g, '$1-$2'), pages: doc.numPages, bytes: buf.length }
}

describe('evidence pack PDF (task 6.1)', () => {
  it('formats dates in UTC whatever the reader\'s time zone', () => {
    expect(day('2026-11-17')).toBe('17 Nov 2026')
    expect(when('2026-11-17T23:59:00+05:30')).toBe('17 Nov 2026 18:29')
    expect(when(null)).toBe('')
    expect(evidenceFileName(SAMPLE)).toBe('evidence-pack-2026-08-19-to-2026-11-17.pdf')
  })

  it('counts each section', () => {
    expect(sectionCounts(SAMPLE)).toEqual({ inventory: 1, approvals: 3002, incidents: 1, autonomy: 1, reviews: 1, killswitch: 3, drift: 1,
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
    expect(text).toContain('Showing the first 1 of 3,001')
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
})
