// Task 6.1 (R5.5): the evidence pack as a PDF. `evidence_pack(from, to)` in the database gathers the records; this
// lays them out (pdfmake document definition), and `downloadEvidencePdf` makes the file in the browser.
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import { DATA_LABEL, formatMoney, REGISTRATION_LABEL, REVIEW_LABEL, RISK_LABEL, ROLE_LABEL, STATUS_LABEL } from '@/lib/format'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export interface EvidenceList { total: number; rows: Row[] }
export interface EvidencePack {
  period: { from: string; to: string; timezone: string }
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "17 Nov 2026" from "2026-11-17". */
export function day(d: string | null | undefined): string {
  if (!d) return ''
  const [y, m, dd] = d.slice(0, 10).split('-').map(Number)
  return `${dd} ${MONTHS[m - 1]} ${y}`
}
/** "17 Nov 2026 09:14" in UTC, whatever the reader's time zone (the whole pack is in UTC). */
export function when(ts: string | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return `${day(d.toISOString())} ${d.toISOString().slice(11, 16)}`
}
const words = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '')
const txt = (v: unknown): string => (v == null ? '' : String(v))
const num = (v: unknown) => Number(v ?? 0).toLocaleString('en-GB')
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`

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

function table(list: EvidenceList, head: string[], widths: (string | number)[], cells: (r: Row) => TableCell[], cap: number, none: string): Content[] {
  if (list.total === 0) return [{ text: none, style: 'none' }]
  const out: Content[] = [{
    table: { headerRows: 1, widths, dontBreakRows: true, body: [head.map((h) => ({ text: h, style: 'th' })), ...list.rows.map((r) => cells(r).map((c) => (typeof c === 'string' ? { text: c } : c)))] },
    layout: 'lightHorizontalLines', style: 'table',
  }]
  if (list.total > list.rows.length) {
    out.push({ text: `Showing the first ${list.rows.length.toLocaleString('en-GB')} of ${list.total.toLocaleString('en-GB')} (each list stops at ${cap.toLocaleString('en-GB')}). Choose a shorter period to see them all.`, style: 'cut' })
  }
  return out
}
const h1 = (n: number, title: string, count: string, about: string): Content[] => [
  { text: `${n}. ${title}`, style: 'h1', pageBreak: 'before' },
  { text: count, style: 'count' },
  { text: about, style: 'about' },
]
const h2 = (title: string): Content => ({ text: title, style: 'h2' })

/** The PDF, as a pdfmake document definition. */
export function buildEvidenceDoc(p: EvidencePack): TDocumentDefinitions {
  const range = `${day(p.period.from)} to ${day(p.period.to)}`
  const counts = sectionCounts(p)
  const a = p.attestation
  const roles = p.generated.roles.map((r) => ROLE_LABEL[r as keyof typeof ROLE_LABEL] ?? r).join(', ')
  const by = `${p.generated.by ?? 'Unknown'}${p.generated.job_title ? `, ${p.generated.job_title}` : ''}${roles ? ` (${roles})` : ''}`
  const ok = (v: boolean | null) => (v === false ? { text: 'Failed', color: '#b91c1c', bold: true } : v ? 'OK' : 'Not finished')

  const content: Content[] = [
    { text: 'Agent Control Tower', style: 'brand' },
    { text: 'Evidence pack', style: 'title' },
    { text: range, style: 'subtitle' },
    { text: `All dates and times are UTC. Produced ${when(p.generated.at)} UTC by ${by}. Recorded in the audit trail as entry #${a.pack_seq}.`, style: 'about' },
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

    ...h1(1, 'Agent inventory', plural(p.inventory.total, 'agent'),
      'Every agent registered by the end of the period, as it stands when the pack was produced: who owns it, how risky it is, how much it may do alone, where it runs and when it was last reviewed.'),
    ...table(p.inventory, ['Agent', 'Department', 'Business owner', 'Technical owner', 'Risk', 'Autonomy', 'Status', 'Source', 'Data', 'Approved', 'Next review'],
      [90, 60, 65, 65, 40, 40, 50, 70, 70, 50, 70],
      (r) => [`${r.code} ${r.name}`, txt(r.department), txt(r.business_owner) || { text: 'No owner', color: '#b91c1c' }, txt(r.technical_owner),
        RISK_LABEL[r.risk_tier as keyof typeof RISK_LABEL] ?? txt(r.risk_tier), `Level ${r.autonomy_level}`,
        STATUS_LABEL[r.status as keyof typeof STATUS_LABEL] ?? txt(r.status), txt(r.source),
        (r.data ?? []).map((d: string) => DATA_LABEL[d as keyof typeof DATA_LABEL] ?? d).join(', '), day(r.approved_at),
        `${day(r.next_review)}${r.review_required ? `\nReview required: ${r.review_required}` : ''}`],
      p.cap, 'No agents were registered by the end of this period.'),

    ...h1(2, 'Approvals', `${plural(p.registrations.total, 'registration')} decided, ${plural(p.requests.total, 'action request')} decided by people`,
      'Who approved each agent before it could go live, and each action an agent asked a person to approve, with every approver (a Critical agent needs two).'),
    h2('Agent registrations'),
    ...table(p.registrations, ['Agent', 'Submitted', 'Decided', 'Outcome', 'Decisions'], [130, 70, 70, 55, '*'],
      (r) => [txt(r.agent), when(r.submitted_at), when(r.decided_at), REGISTRATION_LABEL[r.outcome as keyof typeof REGISTRATION_LABEL] ?? words(r.outcome),
        (r.decisions ?? []).map((d: Row) => `${d.by}: ${words(d.decision)} ${when(d.at)}${d.reason ? ` (${d.reason})` : ''}`).join('\n')],
      p.cap, 'No registrations were decided in this period.'),
    h2('Action requests decided by people'),
    ...table(p.requests, ['Request', 'Agent', 'Action', 'Amount', 'Asked', 'Decided', 'Outcome', 'Approved by', 'Reason'], [55, 95, 85, 70, 60, 60, 45, 85, '*'],
      (r) => [txt(r.code), txt(r.agent), txt(r.action), r.amount != null ? formatMoney(Number(r.amount), r.currency ?? 'GBP') : '', when(r.requested_at), when(r.decided_at),
        words(r.outcome), (r.approvers?.length ? r.approvers : r.decided_by ? [r.decided_by] : []).join(', '), txt(r.reason)],
      p.cap, 'No action requests were decided by people in this period.'),
    { text: `Not listed: ${plural(p.requests.expired, 'request')} that expired because nobody decided in time, and ${plural(p.requests.refused, 'request')} refused automatically by the agent's limits.`, style: 'about' },

    ...h1(3, 'Incidents', plural(p.incidents.total, 'incident'), 'Incidents opened in the period, closed in it, or still not closed at its end.'),
    ...table(p.incidents, ['Incident', 'Agent', 'Severity', 'Title', 'Raised by', 'Owner', 'Opened', 'Due', 'Status', 'Closed'], [50, 95, 45, '*', 55, 70, 60, 60, 50, 60],
      (r) => [txt(r.code), txt(r.agent), RISK_LABEL[r.severity as keyof typeof RISK_LABEL] ?? txt(r.severity), txt(r.title),
        r.source === 'suspension' ? 'Kill switch' : r.source === 'agent_report' ? 'The agent' : 'Integration', txt(r.owner), when(r.opened_at), when(r.due_at), words(r.status), when(r.closed_at)],
      p.cap, 'No incidents in this period.'),

    ...h1(4, 'Autonomy changes', plural(p.autonomy.total, 'change'), "Every change to how much an agent may do without a person, from the audit trail."),
    ...table(p.autonomy, ['Audit #', 'When', 'Agent', 'From', 'To', 'Changed by', 'Reason'], [45, 70, 150, 45, 45, 100, '*'],
      (r) => [`#${r.seq}`, when(r.at), txt(r.agent).trim(), `Level ${r.from}`, `Level ${r.to}`, txt(r.by), txt(r.reason)],
      p.cap, 'No autonomy levels changed in this period.'),

    ...h1(5, 'Reviews', plural(p.reviews.total, 'review'), 'Periodic reviews of agents done in the period, and the outcome.'),
    ...table(p.reviews, ['When', 'Agent', 'Reviewer', 'Outcome', 'Notes', 'Next review'], [70, 150, 100, 80, '*', 70],
      (r) => [when(r.at), txt(r.agent), txt(r.by), REVIEW_LABEL[r.outcome as keyof typeof REVIEW_LABEL] ?? words(r.outcome), txt(r.notes), day(r.next)],
      p.cap, 'No reviews were done in this period.'),

    ...h1(6, 'Kill-switch events', `${plural(p.suspensions.total, 'suspension')}, ${plural(p.reactivations.total, 'request')} to switch back on, ${plural(p.enforcement.total, 'step')} to stop or restore`,
      'Agents stopped with the kill switch and why, requests to switch them back on and who approved them, and each step taken to stop or restore them on their platform, by webhook or by email, with the result read back.'),
    h2('Suspensions'),
    ...table(p.suspensions, ['Agent', 'Asked by', 'Asked', 'Confirmed by', 'Stopped', 'Status', 'Reason'], [130, 80, 65, 80, 65, 50, '*'],
      (r) => [txt(r.agent), txt(r.requested_by), when(r.requested_at), txt(r.confirmed_by), when(r.suspended_at),
        r.status === 'done' ? 'Suspended' : r.status === 'waiting' ? 'Waiting for a second person' : 'Withdrawn', txt(r.reason)],
      p.cap, 'No agents were suspended in this period.'),
    h2('Requests to switch back on'),
    ...table(p.reactivations, ['Agent', 'Asked by', 'Asked', 'Why', 'Status', 'Approved by', 'Decided'], [130, 80, 65, '*', 55, 100, 65],
      (r) => [txt(r.agent), txt(r.requested_by), when(r.requested_at), txt(r.reason), words(r.status), (r.approvers ?? []).join(', '), when(r.decided_at)],
      p.cap, 'No requests to switch an agent back on in this period.'),
    h2('Steps to stop or restore'),
    ...table(p.enforcement, ['Agent', 'Step', 'Why', 'Where', 'Started', 'Finished', 'Tries', 'Result'], [110, 40, 55, 130, 60, 60, 30, '*'],
      (r) => [txt(r.agent), r.action === 'stop' ? 'Stop' : 'Restore', words(r.cause), txt(r.target), when(r.created_at), when(r.finished_at), txt(r.attempts),
        r.status === 'failed' ? { text: `Failed: ${txt(r.detail)}`, color: '#b91c1c' } : `${words(r.status)}${r.detail ? `: ${r.detail}` : ''}`],
      p.cap, 'No stop or restore steps in this period.'),

    ...h1(7, 'Drift', plural(p.drift.total, 'change'), 'Changes made to agents on their platform outside the Control Tower, who made them (when the platform says), and what the Control Tower did.'),
    ...table(p.drift, ['Detected', 'Agent', 'What changed', 'Expected', 'Found', 'By', 'Action', 'Result', 'Incident'], [60, 95, 70, 70, 70, 65, '*', 80, 45],
      (r) => [when(r.at), txt(r.agent), words(r.kind), txt(r.expected), txt(r.observed), txt(r.actor), txt(r.action), txt(r.result), txt(r.incident)],
      p.cap, 'No changes outside the Control Tower were detected in this period.'),

    ...h1(8, 'Re-quarantine actions', plural(p.requarantine.total, 'action'), 'Suspended agents found switched back on outside the Control Tower and blocked again, with the status read back from the platform.'),
    ...table(p.requarantine, ['Agent', 'Where', 'Started', 'Finished', 'Tries', 'Result'], [130, 160, 70, 70, 30, '*'],
      (r) => [txt(r.agent), txt(r.target), when(r.created_at), when(r.finished_at), txt(r.attempts),
        r.status === 'failed' ? { text: `Failed: ${txt(r.detail)}`, color: '#b91c1c' } : `${words(r.status)}${r.detail ? `: ${r.detail}` : ''}`],
      p.cap, 'No agents had to be blocked again in this period.'),

    ...h1(9, 'Sync history', `${plural(p.sync.platforms.length, 'platform')}`, "How often each platform's agent list was fetched and checked, and every fetch or check that failed or found a change."),
    p.sync.platforms.length === 0 ? { text: 'No agent platforms are connected.', style: 'none' } : {
      table: {
        headerRows: 1, widths: ['*', 70, 60, 50, 90, 90, 80],
        body: [
          ['Platform', 'Every', 'Fetches', 'Failed', 'Reconciliation checks', 'Last good fetch', 'Agents listed now'].map((h) => ({ text: h, style: 'th' })),
          ...p.sync.platforms.map((x) => [txt(x.name), x.every_minutes ? `${x.every_minutes} minutes` : 'Off', num(x.syncs),
            Number(x.failed) > 0 ? { text: num(x.failed), color: '#b91c1c', bold: true } : '0', num(x.reconciliations), when(x.last_sync), num(x.agents)]),
        ],
      },
      layout: 'lightHorizontalLines', style: 'table',
    },
    h2('Fetches and checks that failed or found a change'),
    ...table(p.sync, ['When', 'Platform', 'Kind', 'Result', 'Message'], [70, 150, 70, 60, '*'],
      (r) => [when(r.at), txt(r.platform), r.kind === 'sync' ? 'Fetch' : 'Reconciliation', ok(r.ok), txt(r.message)],
      p.cap, 'Every fetch and check in this period worked and found no change.'),

    ...h1(10, 'Attestation', a.chain_intact ? 'Audit trail intact' : 'Audit trail BROKEN',
      'How this pack can be trusted: it is printed straight from the Control Tower\'s records, and those records are kept in an audit trail that cannot be edited.'),
    {
      text: [
        `This pack was produced from the Agent Control Tower's records on ${when(p.generated.at)} UTC by ${by}, and is recorded in the audit trail as entry #${a.pack_seq}. `,
        'The audit trail is insert-only: the database refuses any change or deletion. Each entry is hash-chained: its SHA-256 hash covers the entry and the hash of the entry before it, so altering or removing any past entry breaks every hash after it. ',
        a.chain_intact
          ? `When this pack was produced, the whole chain (${a.chain_length.toLocaleString('en-GB')} entries) was recomputed and found intact.`
          : { text: `When this pack was produced, the chain was recomputed and found BROKEN at entry #${a.chain_broken_at}: the records from there on cannot be relied on without investigation.`, bold: true, color: '#b91c1c' },
      ],
      style: 'body',
    },
    {
      table: {
        widths: [150, '*'],
        body: [
          ['Audit entries in the period', a.period_events.toLocaleString('en-GB')],
          ['First entry in the period', a.period_first ? `#${a.period_first.seq} · ${when(a.period_first.at)}\n${a.period_first.hash}` : 'None'],
          ['Last entry in the period', a.period_last ? `#${a.period_last.seq} · ${when(a.period_last.at)}\n${a.period_last.hash}` : 'None'],
          ['Chain checked', a.chain_intact ? `Intact, ${a.chain_length.toLocaleString('en-GB')} entries` : { text: `Broken at entry #${a.chain_broken_at}`, color: '#b91c1c', bold: true }],
          ['Latest hash when produced', txt(a.latest_hash)],
          ['Digest of this pack\'s data (SHA-256)', `${a.digest}\nAlso stored with audit entry #${a.pack_seq}.`],
        ].map(([k, v]) => [{ text: k, bold: true }, typeof v === 'string' ? { text: v, style: 'mono' } : v]),
      },
      layout: 'lightHorizontalLines', style: 'table', margin: [0, 8, 0, 16],
    },
    { text: 'Attested by', style: 'h2' },
    {
      table: {
        widths: [120, '*'], heights: 28,
        body: [['Name', ''], ['Role', ''], ['Signature', ''], ['Date', '']].map(([k]) => [{ text: k, bold: true }, '']),
      },
      layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => '#94a3b8' },
    },
  ]

  return {
    pageSize: 'A4', pageOrientation: 'landscape', pageMargins: [36, 40, 36, 40],
    info: { title: `Evidence pack ${p.period.from} to ${p.period.to}`, author: 'Agent Control Tower', subject: 'Evidence pack' },
    content,
    footer: (page, pages) => ({
      columns: [
        { text: `Agent Control Tower · Evidence pack ${range} · audit entry #${a.pack_seq}`, style: 'foot' },
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

export const evidenceFileName = (p: Pick<EvidencePack, 'period'>) => `evidence-pack-${p.period.from}-to-${p.period.to}.pdf`

/** Makes the PDF in the browser and saves it. pdfmake and its fonts load only when someone asks for a pack. */
export async function downloadEvidencePdf(p: EvidencePack): Promise<void> {
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')])
  pdfMake.addVirtualFileSystem(vfs)
  await pdfMake.createPdf(buildEvidenceDoc(p)).download(evidenceFileName(p))
}
