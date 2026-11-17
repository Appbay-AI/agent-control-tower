// Test fixtures for the evidence pack (tasks 6.1, 6.2): a sample pack with one record in every section, and a
// helper (evidencePdfText.ts) that prints a real PDF in Node and reads its text back.
import type { EvidencePack } from '@/lib/evidence'

const at = '2026-11-17T09:14:05Z'
const list = (rows: Record<string, unknown>[], total = rows.length) => ({ total, rows })
export const SAMPLE: EvidencePack = {
  period: { from: '2026-08-19', to: '2026-11-17', timezone: 'UTC' },
  generated: { at, by: 'Grace Auditor', email: 'grace@bank.test', job_title: 'Internal Audit Lead', roles: ['auditor'] },
  cap: 2000,
  inventory: list([{ code: 'AGT-0001', name: 'Payment Release Assistant', department: 'Payments', business_owner: 'James Whitfield', technical_owner: null,
    risk_tier: 'critical', autonomy_level: 2, status: 'suspended', source: 'Manual', data: ['personal'], approved_at: at, next_review: '2027-05-17', review_required: null },
    { code: 'AGT-0002', name: 'Treasury Cash Forecaster', department: 'Treasury', business_owner: null, technical_owner: 'Lucy Grant', risk_tier: 'high',
      autonomy_level: 1, status: 'retired', source: 'Northbridge Agent Platform (simulated)', data: [], approved_at: null, next_review: null,
      review_required: '3 incidents in 90 days (INC-0001, INC-0002, INC-0003)' }]),
  registrations: list([{ agent: 'AGT-0001 Payment Release Assistant', submitted_at: at, decided_at: at, outcome: 'approved', required: 2,
    decisions: [{ by: 'Ravi Menon', decision: 'approve', reason: 'Limits are right', at }, { by: 'Daniel Okafor', decision: 'approve', reason: null, at }] }]),
  requests: { ...list([{ code: 'REQ-000123', agent: 'AGT-0001 Payment Release Assistant', action: 'Release payment', amount: 2000000, currency: 'GBP',
    requested_at: at, decided_at: at, outcome: 'approved', approvers: ['Ravi Menon', 'Daniel Okafor'], reason: 'Approved by both' },
    { code: 'REQ-000124', agent: 'AGT-0001 Payment Release Assistant', action: 'Release payment', amount: 5000, currency: 'USD',
    requested_at: at, decided_at: at, outcome: 'rejected', approvers: [], decided_by: 'Ravi Menon', reason: 'Wrong payee' }], 3001), expired: 4, refused: 1 },
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
