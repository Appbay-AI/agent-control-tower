import type {
  AgentFramework, AgentStatus, AppRole, DataClassification, RegistrationStatus, ReviewOutcome, RiskTier,
} from '@/lib/types'

export const STATUS_LABEL: Record<AgentStatus, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  live: 'Live',
  suspended: 'Suspended',
  retired: 'Retired',
}

export const STATUS_STYLE: Record<AgentStatus, string> = {
  proposed: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  approved: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200',
  live: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
  suspended: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
  retired: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
}

export const RISK_LABEL: Record<RiskTier, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' }

export const RISK_STYLE: Record<RiskTier, string> = {
  low: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200',
  critical: 'bg-red-600 text-white',
}

export const AUTONOMY: Record<1 | 2 | 3 | 4, { name: string; text: string }> = {
  1: { name: 'Observe', text: 'May read and recommend only. No actions.' },
  2: { name: 'Act with pre-approval', text: 'Every action needs a human approval first.' },
  3: { name: 'Act within limits', text: 'Acts alone below its limits; above them, needs approval.' },
  4: { name: 'Full autonomy', text: 'Acts alone; every action is logged and sampled for review.' },
}

export const FRAMEWORK_LABEL: Record<AgentFramework, string> = {
  langchain: 'LangChain',
  appian: 'Appian',
  vendor_embedded: 'Vendor-embedded',
  other: 'Other',
}

export const DATA_LABEL: Record<DataClassification, string> = {
  public: 'Public',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
  personal: 'Personal data',
}

export const REGISTRATION_LABEL: Record<RegistrationStatus, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
  sent_back: 'Sent back',
}

export const REVIEW_LABEL: Record<ReviewOutcome, string> = {
  no_change: 'No change',
  changes_required: 'Changes required',
  retire: 'Retire',
}

export const ROLE_LABEL: Record<AppRole, string> = {
  admin: 'Admin',
  approver: 'Approver',
  owner: 'Agent owner',
  executive: 'Executive',
  auditor: 'Auditor',
}

export const ROLE_HELP: Record<AppRole, string> = {
  owner: 'Proposes agents and keeps their records up to date.',
  approver: 'Approves or rejects agents for the departments chosen below.',
  executive: 'Sees every agent and the overall picture. Read only.',
  auditor: 'Sees every agent and the full audit trail. Read only.',
  admin: 'Manages users, departments and integration keys. Sees everything.',
}

export const REGULATORY_FLAGS = ['EU AI Act', 'DORA', 'GDPR', 'SOX', 'GxP', 'PCI DSS', 'Model risk (SR 11-7)']

/** Dates come from Postgres as YYYY-MM-DD or ISO timestamps. Shown as "6 Oct 2026". */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function formatMoney(amount: number | null | undefined, currency = 'GBP'): string {
  if (amount === null || amount === undefined) return '—'
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
}

/** today as YYYY-MM-DD in UTC, matching Postgres current_date on Supabase. */
export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export function isReviewOverdue(nextReview: string | null, status: AgentStatus, now = new Date()): boolean {
  return status === 'live' && nextReview !== null && nextReview < todayIso(now)
}

/** Free text list → array: one item per line or comma, trimmed, no blanks, no duplicates. */
export function parseList(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))]
}

/** Postgres raises friendly messages; PostgREST wraps them. Show only the human part. */
export function errorMessage(error: unknown): string {
  if (!error) return 'Something went wrong'
  if (typeof error === 'string') return error
  const e = error as { message?: string; details?: string }
  return e.message || e.details || 'Something went wrong'
}

// Plain UTC dates for the evidence pack and the dashboard (tasks 6.1, 6.3).
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
