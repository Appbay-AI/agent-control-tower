// Task 6.1 (R5.5): the evidence pack as a PDF. `evidence_pack(from, to)` in the database gathers the records; this
// lays them out (pdfmake document definition), and `downloadEvidencePdf` makes the file in the browser.
import type { Content, CustomTableLayout, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import { DATA_LABEL, day, formatMoney, when, REGISTRATION_LABEL, REVIEW_LABEL, RISK_LABEL, ROLE_LABEL, STATUS_LABEL } from '@/lib/format'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export interface EvidenceList { total: number; rows: Row[] }
export interface EvidencePack {
  period: { from: string; to: string; timezone: string }
  /** 20 Nov: the one agent the pack covers; null (or missing, before then) for every agent. */
  agent?: { id: string; code: string; name: string } | null
  generated: { at: string; by: string | null; email: string | null; job_title: string | null; roles: string[] }
  cap: number
  inventory: EvidenceList
  registrations: EvidenceList
  requests: EvidenceList & { expired: number; refused: number }
  incidents: EvidenceList
  autonomy: EvidenceList
  reviews: EvidenceList
  suspensions: EvidenceList
  reactivations: EvidenceList
  enforcement: EvidenceList
  drift: EvidenceList
  requarantine: EvidenceList
  sync: EvidenceList & { platforms: Row[] }
  attestation: {
    pack_seq: number
    digest: string
    chain_intact: boolean
    chain_broken_at: number | null
    chain_length: number
    period_events: number
    period_first: { seq: number; at: string; hash: string } | null
    period_last: { seq: number; at: string; hash: string } | null
    latest_hash: string | null
  }
}

export { day, when } from '@/lib/format'
const words = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '')
const txt = (v: unknown): string => (v == null ? '' : String(v))
const num = (v: unknown) => Number(v ?? 0).toLocaleString('en-GB')
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`

/** "AGT-0001 Payment Release Assistant" for a pack about one agent; null for the pack about every agent. */
export const packAgent = (p: Pick<EvidencePack, 'agent'>) => (p.agent ? `${p.agent.code} ${p.agent.name}` : null)

/** The sections, in order: title, what it shows, and the list behind it. */
export const SECTIONS = [
  ['inventory', 'Agent inventory'],
  ['approvals', 'Approvals'],
  ['incidents', 'Incidents'],
  ['autonomy', 'Autonomy changes'],
  ['reviews', 'Reviews'],
  ['killswitch', 'Kill-switch events'],
  ['drift', 'Drift'],
  ['requarantine', 'Re-quarantine actions'],
  ['sync', 'Sync history'],
  ['attestation', 'Attestation'],
] as const

/** How many records each section holds, for the contents page and the screen. */
export function sectionCounts(p: EvidencePack): Record<(typeof SECTIONS)[number][0], number> {
  return {
    inventory: p.inventory.total,
    approvals: p.registrations.total + p.requests.total,
    incidents: p.incidents.total,
    autonomy: p.autonomy.total,
    reviews: p.reviews.total,
    killswitch: p.suspensions.total + p.reactivations.total + p.enforcement.total,
    drift: p.drift.total,
    requarantine: p.requarantine.total,
    sync: p.sync.platforms.reduce((n, x) => n + Number(x.syncs ?? 0) + Number(x.reconciliations ?? 0), 0),
    attestation: p.attestation.period_events,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Task 6.2: every table is defined once, and both the PDF and the Excel file are built from these definitions, so
// the two always hold the same rows and the same values. A cell carries its printed text (the PDF) and its typed value
// (Excel: real dates and numbers, shown with the same formatting).
// ---------------------------------------------------------------------------------------------------------------
export type CellKind = 'text' | 'datetime' | 'date' | 'int' | 'money'
export interface Cell { text: string; value: string | number | Date | null; kind: CellKind; numFmt?: string; red?: boolean; bold?: boolean }

const t = (v: unknown, o: { red?: boolean; bold?: boolean } = {}): Cell => ({ text: txt(v), value: v == null || v === '' ? null : txt(v), kind: 'text', ...o })
const dt = (iso: string | null | undefined): Cell => ({ text: when(iso), value: iso && when(iso) ? new Date(iso) : null, kind: 'datetime', numFmt: 'dd mmm yyyy hh:mm' })
const dd = (d: string | null | undefined): Cell => {
  if (!d) return { text: '', value: null, kind: 'date', numFmt: 'dd mmm yyyy' }
  const [y, m, x] = d.slice(0, 10).split('-').map(Number)
  return { text: day(d), value: new Date(Date.UTC(y, m - 1, x)), kind: 'date', numFmt: 'dd mmm yyyy' }
}
const n = (v: unknown, o: { red?: boolean; bold?: boolean } = {}): Cell =>
  v == null ? { text: '', value: null, kind: 'int', numFmt: '#,##0' } : { text: num(v), value: Number(v), kind: 'int', numFmt: '#,##0', ...o }
/** The currency symbol formatMoney prints ("£", "US$", "€"), for Excel's number format. */
export function currencyFormat(currency: string): string {
  const sym = new Intl.NumberFormat('en-GB', { style: 'currency', currency }).formatToParts(0).find((x) => x.type === 'currency')?.value ?? currency
  return `"${sym.replace(/"/g, '')}"#,##0`
}
const money = (amount: unknown, currency: string | null | undefined): Cell =>
  amount == null ? { text: '', value: null, kind: 'money' }
    : { text: formatMoney(Number(amount), currency ?? 'GBP'), value: Number(amount), kind: 'money', numFmt: currencyFormat(currency ?? 'GBP') }
const failedOr = (r: Row): Cell => (r.status === 'failed' ? t(`Failed: ${txt(r.detail)}`, { red: true }) : t(`${words(r.status)}${r.detail ? `: ${r.detail}` : ''}`))

export interface Col { head: string; pdf: number | '*'; xl: number; cell: (r: Row) => Cell }
export interface EvidenceTable {
  id: string
  /** Sheet name in the Excel file (31 characters at most). */
  sheet: string
  /** Sub-heading in the PDF, when a section has more than one table. */
  heading?: string
  none: string | ((p: EvidencePack) => string)
  list: (p: EvidencePack) => EvidenceList
  cols: Col[]
  /** A sentence printed under the table (and above it in Excel). */
  note?: (p: EvidencePack) => string
}
export interface EvidenceSection {
  key: (typeof SECTIONS)[number][0]
  title: string
  count: (p: EvidencePack) => string
  about: string
  tables: EvidenceTable[]
}

export const TABLES: EvidenceSection[] = [
  { key: 'inventory', title: 'Agent inventory', count: (p) => plural(p.inventory.total, 'agent'),
    about: 'Every agent registered by the end of the period, as it stands when the pack was produced: who owns it, how risky it is, how much it may do alone, where it runs and when it was last reviewed.',
    tables: [{ id: 'inventory', sheet: '1 Inventory', none: 'No agents were registered by the end of this period.', list: (p) => p.inventory, cols: [
      { head: 'Agent', pdf: '*', xl: 38, cell: (r) => t(`${r.code} ${r.name}`) },
      { head: 'Department', pdf: 55, xl: 16, cell: (r) => t(r.department) },
      { head: 'Business owner', pdf: 58, xl: 20, cell: (r) => (r.business_owner ? t(r.business_owner) : t('No owner', { red: true })) },
      { head: 'Technical owner', pdf: 58, xl: 20, cell: (r) => t(r.technical_owner) },
      { head: 'Risk', pdf: 36, xl: 10, cell: (r) => t(RISK_LABEL[r.risk_tier as keyof typeof RISK_LABEL] ?? r.risk_tier) },
      { head: 'Autonomy', pdf: 38, xl: 10, cell: (r) => t(`Level ${r.autonomy_level}`) },
      { head: 'Status', pdf: 44, xl: 11, cell: (r) => t(STATUS_LABEL[r.status as keyof typeof STATUS_LABEL] ?? r.status) },
      { head: 'Source', pdf: 62, xl: 26, cell: (r) => t(r.source) },
      { head: 'Data', pdf: 55, xl: 26, cell: (r) => t((r.data ?? []).map((d: string) => DATA_LABEL[d as keyof typeof DATA_LABEL] ?? d).join(', ')) },
      { head: 'Approved', pdf: 46, xl: 13, cell: (r) => dd(r.approved_at) },
      { head: 'Next review', pdf: 46, xl: 13, cell: (r) => dd(r.next_review) },
      { head: 'Review required', pdf: 85, xl: 30, cell: (r) => t(r.review_required, { red: Boolean(r.review_required) }) },
    ] }] },
  { key: 'approvals', title: 'Approvals',
    count: (p) => `${plural(p.registrations.total, 'registration')} decided, ${plural(p.requests.total, 'action request')} decided by people`,
    about: 'Who approved each agent before it could go live, and each action an agent asked a person to approve, with every approver (a Critical agent needs two).',
    tables: [
      { id: 'registrations', sheet: '2a Registrations', heading: 'Agent registrations', none: 'No registrations were decided in this period.', list: (p) => p.registrations, cols: [
        { head: 'Agent', pdf: 130, xl: 38, cell: (r) => t(r.agent) },
        { head: 'Submitted', pdf: 70, xl: 17, cell: (r) => dt(r.submitted_at) },
        { head: 'Decided', pdf: 70, xl: 17, cell: (r) => dt(r.decided_at) },
        { head: 'Outcome', pdf: 55, xl: 12, cell: (r) => t(REGISTRATION_LABEL[r.outcome as keyof typeof REGISTRATION_LABEL] ?? words(r.outcome)) },
        { head: 'Decisions', pdf: '*', xl: 70, cell: (r) => t((r.decisions ?? []).map((d: Row) => `${d.by}: ${words(d.decision)} ${when(d.at)}${d.reason ? ` (${d.reason})` : ''}`).join('\n')) },
      ] },
      { id: 'requests', sheet: '2b Action requests', heading: 'Action requests decided by people', none: 'No action requests were decided by people in this period.', list: (p) => p.requests,
        note: (p) => `Not listed: ${plural(p.requests.expired, 'request')} that expired because nobody decided in time, and ${plural(p.requests.refused, 'request')} refused automatically by the agent's limits.`,
        cols: [
          { head: 'Request', pdf: 55, xl: 12, cell: (r) => t(r.code) },
          { head: 'Agent', pdf: 95, xl: 34, cell: (r) => t(r.agent) },
          { head: 'Action', pdf: 85, xl: 26, cell: (r) => t(r.action) },
          { head: 'Amount', pdf: 70, xl: 14, cell: (r) => money(r.amount, r.currency) },
          { head: 'Asked', pdf: 60, xl: 17, cell: (r) => dt(r.requested_at) },
          { head: 'Decided', pdf: 60, xl: 17, cell: (r) => dt(r.decided_at) },
          { head: 'Outcome', pdf: 45, xl: 11, cell: (r) => t(words(r.outcome)) },
          { head: 'Approved by', pdf: 85, xl: 30, cell: (r) => t((r.approvers?.length ? r.approvers : r.decided_by ? [r.decided_by] : []).join(', ')) },
          { head: 'Reason', pdf: '*', xl: 50, cell: (r) => t(r.reason) },
        ] },
    ] },
  { key: 'incidents', title: 'Incidents', count: (p) => plural(p.incidents.total, 'incident'),
    about: 'Incidents opened in the period, closed in it, or still not closed at its end.',
    tables: [{ id: 'incidents', sheet: '3 Incidents', none: 'No incidents in this period.', list: (p) => p.incidents, cols: [
      { head: 'Incident', pdf: 50, xl: 11, cell: (r) => t(r.code) },
      { head: 'Agent', pdf: 95, xl: 34, cell: (r) => t(r.agent) },
      { head: 'Severity', pdf: 45, xl: 10, cell: (r) => t(RISK_LABEL[r.severity as keyof typeof RISK_LABEL] ?? r.severity) },
      { head: 'Title', pdf: '*', xl: 40, cell: (r) => t(r.title) },
      { head: 'Raised by', pdf: 55, xl: 13, cell: (r) => t(r.source === 'suspension' ? 'Kill switch' : r.source === 'agent_report' ? 'The agent' : 'Integration') },
      { head: 'Owner', pdf: 70, xl: 20, cell: (r) => t(r.owner) },
      { head: 'Opened', pdf: 60, xl: 17, cell: (r) => dt(r.opened_at) },
      { head: 'Due', pdf: 60, xl: 17, cell: (r) => dt(r.due_at) },
      { head: 'Status', pdf: 50, xl: 11, cell: (r) => t(words(r.status)) },
      { head: 'Closed', pdf: 60, xl: 17, cell: (r) => dt(r.closed_at) },
    ] }] },
  { key: 'autonomy', title: 'Autonomy changes', count: (p) => plural(p.autonomy.total, 'change'),
    about: 'Every change to how much an agent may do without a person, from the audit trail.',
    tables: [{ id: 'autonomy', sheet: '4 Autonomy', none: 'No autonomy levels changed in this period.', list: (p) => p.autonomy, cols: [
      { head: 'Audit #', pdf: 45, xl: 10, cell: (r) => n(r.seq) },
      { head: 'When', pdf: 70, xl: 17, cell: (r) => dt(r.at) },
      { head: 'Agent', pdf: 150, xl: 38, cell: (r) => t(txt(r.agent).trim()) },
      { head: 'From', pdf: 45, xl: 9, cell: (r) => t(`Level ${r.from}`) },
      { head: 'To', pdf: 45, xl: 9, cell: (r) => t(`Level ${r.to}`) },
      { head: 'Changed by', pdf: 100, xl: 22, cell: (r) => t(r.by) },
      { head: 'Reason', pdf: '*', xl: 50, cell: (r) => t(r.reason) },
    ] }] },
  { key: 'reviews', title: 'Reviews', count: (p) => plural(p.reviews.total, 'review'),
    about: 'Periodic reviews of agents done in the period, and the outcome.',
    tables: [{ id: 'reviews', sheet: '5 Reviews', none: 'No reviews were done in this period.', list: (p) => p.reviews, cols: [
      { head: 'When', pdf: 70, xl: 17, cell: (r) => dt(r.at) },
      { head: 'Agent', pdf: 150, xl: 38, cell: (r) => t(r.agent) },
      { head: 'Reviewer', pdf: 100, xl: 20, cell: (r) => t(r.by) },
      { head: 'Outcome', pdf: 80, xl: 18, cell: (r) => t(REVIEW_LABEL[r.outcome as keyof typeof REVIEW_LABEL] ?? words(r.outcome)) },
      { head: 'Notes', pdf: '*', xl: 50, cell: (r) => t(r.notes) },
      { head: 'Next review', pdf: 70, xl: 13, cell: (r) => dd(r.next) },
    ] }] },
  { key: 'killswitch', title: 'Kill-switch events',
    count: (p) => `${plural(p.suspensions.total, 'suspension')}, ${plural(p.reactivations.total, 'request')} to switch back on, ${plural(p.enforcement.total, 'step')} to stop or restore`,
    about: 'Agents stopped with the kill switch and why, requests to switch them back on and who approved them, and each step taken to stop or restore them on their platform, by webhook or by email, with the result read back.',
    tables: [
      { id: 'suspensions', sheet: '6a Suspensions', heading: 'Suspensions', none: 'No agents were suspended in this period.', list: (p) => p.suspensions, cols: [
        { head: 'Agent', pdf: 130, xl: 38, cell: (r) => t(r.agent) },
        { head: 'Asked by', pdf: 80, xl: 20, cell: (r) => t(r.requested_by) },
        { head: 'Asked', pdf: 65, xl: 17, cell: (r) => dt(r.requested_at) },
        { head: 'Confirmed by', pdf: 80, xl: 20, cell: (r) => t(r.confirmed_by) },
        { head: 'Stopped', pdf: 65, xl: 17, cell: (r) => dt(r.suspended_at) },
        { head: 'Status', pdf: 50, xl: 16, cell: (r) => t(r.status === 'done' ? 'Suspended' : r.status === 'waiting' ? 'Waiting for a second person' : 'Withdrawn') },
        { head: 'Reason', pdf: '*', xl: 50, cell: (r) => t(r.reason) },
      ] },
      { id: 'reactivations', sheet: '6b Switch back on', heading: 'Requests to switch back on', none: 'No requests to switch an agent back on in this period.', list: (p) => p.reactivations, cols: [
        { head: 'Agent', pdf: 130, xl: 38, cell: (r) => t(r.agent) },
        { head: 'Asked by', pdf: 80, xl: 20, cell: (r) => t(r.requested_by) },
        { head: 'Asked', pdf: 65, xl: 17, cell: (r) => dt(r.requested_at) },
        { head: 'Why', pdf: '*', xl: 50, cell: (r) => t(r.reason) },
        { head: 'Status', pdf: 55, xl: 12, cell: (r) => t(words(r.status)) },
        { head: 'Approved by', pdf: 100, xl: 30, cell: (r) => t((r.approvers ?? []).join(', ')) },
        { head: 'Decided', pdf: 65, xl: 17, cell: (r) => dt(r.decided_at) },
      ] },
      { id: 'enforcement', sheet: '6c Stop or restore steps', heading: 'Steps to stop or restore', none: 'No stop or restore steps in this period.', list: (p) => p.enforcement, cols: [
        { head: 'Agent', pdf: 110, xl: 34, cell: (r) => t(r.agent) },
        { head: 'Step', pdf: 40, xl: 9, cell: (r) => t(r.action === 'stop' ? 'Stop' : 'Restore') },
        { head: 'Why', pdf: 55, xl: 12, cell: (r) => t(words(r.cause)) },
        { head: 'Where', pdf: 130, xl: 44, cell: (r) => t(r.target) },
        { head: 'Started', pdf: 60, xl: 17, cell: (r) => dt(r.created_at) },
        { head: 'Finished', pdf: 60, xl: 17, cell: (r) => dt(r.finished_at) },
        { head: 'Tries', pdf: 30, xl: 7, cell: (r) => n(r.attempts) },
        { head: 'Result', pdf: '*', xl: 50, cell: failedOr },
      ] },
    ] },
  { key: 'drift', title: 'Drift', count: (p) => plural(p.drift.total, 'change'),
    about: 'Changes made to agents on their platform outside the Control Tower, who made them (when the platform says), and what the Control Tower did.',
    tables: [{ id: 'drift', sheet: '7 Drift', none: 'No changes outside the Control Tower were detected in this period.', list: (p) => p.drift, cols: [
      { head: 'Detected', pdf: 60, xl: 17, cell: (r) => dt(r.at) },
      { head: 'Agent', pdf: 95, xl: 34, cell: (r) => t(r.agent) },
      { head: 'What changed', pdf: 70, xl: 20, cell: (r) => t(words(r.kind)) },
      { head: 'Expected', pdf: 70, xl: 20, cell: (r) => t(r.expected) },
      { head: 'Found', pdf: 70, xl: 20, cell: (r) => t(r.observed) },
      { head: 'By', pdf: 65, xl: 26, cell: (r) => t(r.actor) },
      { head: 'Action', pdf: '*', xl: 30, cell: (r) => t(r.action) },
      { head: 'Result', pdf: 80, xl: 30, cell: (r) => t(r.result) },
      { head: 'Incident', pdf: 45, xl: 11, cell: (r) => t(r.incident) },
    ] }] },
  { key: 'requarantine', title: 'Re-quarantine actions', count: (p) => plural(p.requarantine.total, 'action'),
    about: 'Suspended agents found switched back on outside the Control Tower and blocked again, with the status read back from the platform.',
    tables: [{ id: 'requarantine', sheet: '8 Re-quarantine', none: 'No agents had to be blocked again in this period.', list: (p) => p.requarantine, cols: [
      { head: 'Agent', pdf: 130, xl: 38, cell: (r) => t(r.agent) },
      { head: 'Where', pdf: 160, xl: 44, cell: (r) => t(r.target) },
      { head: 'Started', pdf: 70, xl: 17, cell: (r) => dt(r.created_at) },
      { head: 'Finished', pdf: 70, xl: 17, cell: (r) => dt(r.finished_at) },
      { head: 'Tries', pdf: 30, xl: 7, cell: (r) => n(r.attempts) },
      { head: 'Result', pdf: '*', xl: 50, cell: failedOr },
    ] }] },
  { key: 'sync', title: 'Sync history', count: (p) => plural(p.sync.platforms.length, 'platform'),
    about: "How often each platform's agent list was fetched and checked, and every fetch or check that failed or found a change.",
    tables: [
      { id: 'platforms', sheet: '9a Sync by platform', none: (p) => (p.agent ? 'This agent is not on a connected agent platform.' : 'No agent platforms are connected.'), list: (p) => ({ total: p.sync.platforms.length, rows: p.sync.platforms }), cols: [
        { head: 'Platform', pdf: '*', xl: 40, cell: (r) => t(r.name) },
        { head: 'Every', pdf: 70, xl: 12, cell: (r) => t(r.every_minutes ? `${r.every_minutes} minutes` : 'Off') },
        { head: 'Fetches', pdf: 60, xl: 10, cell: (r) => n(r.syncs) },
        { head: 'Failed', pdf: 50, xl: 9, cell: (r) => n(r.failed, Number(r.failed) > 0 ? { red: true, bold: true } : {}) },
        { head: 'Reconciliation checks', pdf: 90, xl: 14, cell: (r) => n(r.reconciliations) },
        { head: 'Last good fetch', pdf: 90, xl: 17, cell: (r) => dt(r.last_sync) },
        { head: 'Agents listed now', pdf: 80, xl: 12, cell: (r) => n(r.agents) },
      ] },
      { id: 'sync', sheet: '9b Sync failures and changes', heading: 'Fetches and checks that failed or found a change', none: 'Every fetch and check in this period worked and found no change.',
        list: (p) => p.sync, cols: [
          { head: 'When', pdf: 70, xl: 17, cell: (r) => dt(r.at) },
          { head: 'Platform', pdf: 150, xl: 40, cell: (r) => t(r.platform) },
          { head: 'Kind', pdf: 70, xl: 15, cell: (r) => t(r.kind === 'sync' ? 'Fetch' : 'Reconciliation') },
          { head: 'Result', pdf: 60, xl: 12, cell: (r) => (r.ok === false ? t('Failed', { red: true, bold: true }) : t(r.ok ? 'OK' : 'Not finished')) },
          { head: 'Message', pdf: '*', xl: 70, cell: (r) => t(r.message) },
        ] },
    ] },
]

/** What a table says when it is empty. */
export const noneText = (tb: EvidenceTable, p: EvidencePack) => (typeof tb.none === 'function' ? tb.none(p) : tb.none)

/** "Showing the first 2,000 of 3,001 …" when a list was cut. */
export function cutNote(list: EvidenceList, cap: number): string | null {
  return list.total > list.rows.length
    ? `Showing the first ${list.rows.length.toLocaleString('en-GB')} of ${list.total.toLocaleString('en-GB')} (each list stops at ${cap.toLocaleString('en-GB')}). Choose a shorter period to see them all.`
    : null
}

/** Who produced the pack, in words: "Grace Auditor, Internal Audit Lead (Auditor)". */
export function producedBy(p: EvidencePack): string {
  const roles = p.generated.roles.map((r) => ROLE_LABEL[r as keyof typeof ROLE_LABEL] ?? r).join(', ')
  return `${p.generated.by ?? 'Unknown'}${p.generated.job_title ? `, ${p.generated.job_title}` : ''}${roles ? ` (${roles})` : ''}`
}

/** The attestation, shared by the PDF and the Excel file. */
export function attestation(p: EvidencePack): { intro: string; rule: string; result: string; broken: boolean; facts: [string, string][]; sign: string[] } {
  const a = p.attestation
  const only = p.agent ? ` for ${p.agent.code}` : ''
  return {
    intro: `This pack was produced from the Agent Control Tower's records on ${when(p.generated.at)} UTC by ${producedBy(p)}, and is recorded in the audit trail as entry #${a.pack_seq}.`,
    rule: 'The audit trail is insert-only: the database refuses any change or deletion. Each entry is hash-chained: its SHA-256 hash covers the entry and the hash of the entry before it, so altering or removing any past entry breaks every hash after it.',
    result: a.chain_intact
      ? `When this pack was produced, the whole chain (${a.chain_length.toLocaleString('en-GB')} entries) was recomputed and found intact.`
      : `When this pack was produced, the chain was recomputed and found BROKEN at entry #${a.chain_broken_at}: the records from there on cannot be relied on without investigation.`,
    broken: !a.chain_intact,
    facts: [
      [`Audit entries${only} in the period`, a.period_events.toLocaleString('en-GB')],
      [`First entry${only} in the period`, a.period_first ? `#${a.period_first.seq} · ${when(a.period_first.at)}\n${a.period_first.hash}` : 'None'],
      [`Last entry${only} in the period`, a.period_last ? `#${a.period_last.seq} · ${when(a.period_last.at)}\n${a.period_last.hash}` : 'None'],
      ['Chain checked', a.chain_intact ? `Intact, ${a.chain_length.toLocaleString('en-GB')} entries` : `Broken at entry #${a.chain_broken_at}`],
      ['Latest hash when produced', txt(a.latest_hash)],
      ["Digest of this pack's data (SHA-256)", `${a.digest}\nAlso stored with audit entry #${a.pack_seq}.`],
    ],
    sign: ['Name', 'Role', 'Signature', 'Date'],
  }
}

/** Landscape A4 less the margins, in points: every table must fit (unit-tested). */
export const PAGE_WIDTH = 842 - 72
/** Cell padding: 4 points either side of each column boundary (the stock light layout's 8 pushed wide tables off the page). */
export const CELL_PAD = 4
const TABLE_LAYOUT: CustomTableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : i === 1 ? 1 : 0.5),
  vLineWidth: () => 0,
  hLineColor: (i) => (i === 1 ? '#0f172a' : '#cbd5e1'),
  paddingLeft: (i) => (i === 0 ? 0 : CELL_PAD),
  paddingRight: (i, node) => (i === (node.table.widths?.length ?? 1) - 1 ? 0 : CELL_PAD),
}
/** Width a table needs besides its '*' column (fixed widths plus padding). */
export const fixedWidth = (cols: Col[]) => cols.reduce((n, c) => n + (c.pdf === '*' ? 0 : c.pdf), 0) + 2 * CELL_PAD * (cols.length - 1)

function pdfTable(tb: EvidenceTable, p: EvidencePack): Content[] {
  const list = tb.list(p)
  const out: Content[] = tb.heading ? [{ text: tb.heading, style: 'h2' }] : []
  if (list.total === 0) out.push({ text: noneText(tb, p), style: 'none' })
  else {
    const cell = (c: Cell): TableCell => ({ text: c.text, ...(c.red ? { color: '#b91c1c' } : {}), ...(c.bold ? { bold: true } : {}) })
    out.push({
      table: { headerRows: 1, widths: tb.cols.map((c) => c.pdf), dontBreakRows: true,
        body: [tb.cols.map((c) => ({ text: c.head, style: 'th' })), ...list.rows.map((r) => tb.cols.map((c) => cell(c.cell(r))))] },
      layout: TABLE_LAYOUT, style: 'table',
    })
    const cut = cutNote(list, p.cap)
    if (cut) out.push({ text: cut, style: 'cut' })
  }
  if (tb.note) out.push({ text: tb.note(p), style: 'about' })
  return out
}

/** The PDF, as a pdfmake document definition. */
export function buildEvidenceDoc(p: EvidencePack): TDocumentDefinitions {
  const range = `${day(p.period.from)} to ${day(p.period.to)}`
  const agent = packAgent(p)
  const counts = sectionCounts(p)
  const a = p.attestation
  const at = attestation(p)

  const content: Content[] = [
    { text: 'Agent Control Tower', style: 'brand' },
    { text: 'Evidence pack', style: 'title' },
    { text: range, style: 'subtitle' },
    ...(agent ? [{ text: `Agent: ${agent}`, style: 'subtitle' }, { text: 'This pack covers this one agent only: every list below holds only its records.', style: 'about' }] : []),
    { text: `All dates and times are UTC. Produced ${when(p.generated.at)} UTC by ${producedBy(p)}. Recorded in the audit trail as entry #${a.pack_seq}.`, style: 'about' },
    {
      table: {
        widths: [20, '*', 90],
        body: [
          [{ text: '', style: 'th' }, { text: 'Section', style: 'th' }, { text: 'Records', style: 'th', alignment: 'right' }],
          ...SECTIONS.map(([k, title], i) => [`${i + 1}.`, title, { text: counts[k].toLocaleString('en-GB'), alignment: 'right' as const }]),
        ],
      },
      layout: 'lightHorizontalLines', style: 'table', margin: [0, 12, 0, 0],
    },
    {
      text: a.chain_intact
        ? `Audit trail checked when this pack was produced: all ${a.chain_length.toLocaleString('en-GB')} entries intact.`
        : `Audit trail checked when this pack was produced: BROKEN at entry #${a.chain_broken_at}. See section 10.`,
      style: a.chain_intact ? 'good' : 'bad', margin: [0, 12, 0, 0],
    },
    ...TABLES.flatMap((s, i): Content[] => [
      { text: `${i + 1}. ${s.title}`, style: 'h1', pageBreak: 'before' },
      { text: s.count(p), style: 'count' },
      { text: s.about, style: 'about' },
      ...s.tables.flatMap((tb) => pdfTable(tb, p)),
    ]),

    { text: '10. Attestation', style: 'h1', pageBreak: 'before' },
    { text: a.chain_intact ? 'Audit trail intact' : 'Audit trail BROKEN', style: 'count' },
    { text: 'How this pack can be trusted: it is printed straight from the Control Tower\'s records, and those records are kept in an audit trail that cannot be edited.', style: 'about' },
    { text: [`${at.intro} `, `${at.rule} `, at.broken ? { text: at.result, bold: true, color: '#b91c1c' } : at.result], style: 'body' },
    {
      table: {
        widths: [150, '*'],
        body: at.facts.map(([k, v]) => [{ text: k, bold: true }, k === 'Chain checked' && at.broken ? { text: v, color: '#b91c1c', bold: true } : { text: v, style: 'mono' }]),
      },
      layout: 'lightHorizontalLines', style: 'table', margin: [0, 8, 0, 16],
    },
    { text: 'Attested by', style: 'h2' },
    {
      table: { widths: [120, '*'], heights: 28, body: at.sign.map((k) => [{ text: k, bold: true }, '']) },
      layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => '#94a3b8' },
    },
  ]

  return {
    pageSize: 'A4', pageOrientation: 'landscape', pageMargins: [36, 40, 36, 40],
    info: { title: `Evidence pack ${agent ? `${agent} ` : ''}${p.period.from} to ${p.period.to}`, author: 'Agent Control Tower', subject: 'Evidence pack' },
    content,
    footer: (page, pages) => ({
      columns: [
        { text: `Agent Control Tower · Evidence pack ${agent ? `${p.agent!.code} · ` : ''}${range} · audit entry #${a.pack_seq}`, style: 'foot' },
        { text: `Page ${page} of ${pages}`, alignment: 'right', style: 'foot' },
      ], margin: [36, 12, 36, 0],
    }),
    defaultStyle: { fontSize: 8, lineHeight: 1.15 },
    styles: {
      brand: { fontSize: 11, color: '#475569', margin: [0, 80, 0, 4] },
      title: { fontSize: 28, bold: true },
      subtitle: { fontSize: 16, margin: [0, 4, 0, 12] },
      h1: { fontSize: 16, bold: true, margin: [0, 0, 0, 2] },
      count: { fontSize: 10, color: '#334155', margin: [0, 0, 0, 4] },
      about: { fontSize: 9, color: '#475569', margin: [0, 0, 0, 8] },
      h2: { fontSize: 11, bold: true, margin: [0, 10, 0, 4] },
      th: { bold: true, fontSize: 8, color: '#0f172a' },
      table: { margin: [0, 0, 0, 6] },
      none: { italics: true, color: '#64748b', margin: [0, 0, 0, 6] },
      cut: { italics: true, color: '#b45309', margin: [0, 0, 0, 6] },
      body: { fontSize: 9.5, lineHeight: 1.3 },
      mono: { fontSize: 7.5 },
      good: { fontSize: 10, bold: true, color: '#047857' },
      bad: { fontSize: 10, bold: true, color: '#b91c1c' },
      foot: { fontSize: 7, color: '#64748b' },
    },
  }
}

export const evidenceFileName = (p: Pick<EvidencePack, 'period' | 'agent'>) => `evidence-pack-${p.agent ? `${p.agent.code}-` : ''}${p.period.from}-to-${p.period.to}.pdf`

/** Makes the PDF in the browser and saves it. pdfmake and its fonts load only when someone asks for a pack. */
export async function downloadEvidencePdf(p: EvidencePack): Promise<void> {
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')])
  pdfMake.addVirtualFileSystem(vfs)
  await pdfMake.createPdf(buildEvidenceDoc(p)).download(evidenceFileName(p))
}
