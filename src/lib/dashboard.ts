// Task 6.3 (R5.3): the executive dashboard's figures (`executive_dashboard()` in the database) and how they read.
import { day } from '@/lib/format'

type Tier = 'low' | 'medium' | 'high' | 'critical'
export interface ExecutiveDashboard {
  at: string
  agents: number
  by_status: { proposed: number; approved: number; live: number; suspended: number }
  by_tier: { tier: Tier; agents: number; live: number }[]
  by_source: { platform: number; api: number; manual: number }
  coverage: { listed: number; governed: number; awaiting: number; retired: number; unlinked: number }
  no_owner: { count: number; agents: { id: string; code: string; name: string }[] }
  overdue_reviews: { count: number; agents: { id: string; code: string; name: string; due: string }[] }
  incidents: { open: number; contained: number; overdue: number; by_severity: Record<Tier, number> }
  incidents_by_week: ({ week: string } & Record<Tier, number>)[]
  pending: { registrations: number; requests: number; reactivations: number; closures: number; oldest: string | null }
  approval_time: {
    requests: { decided: number; avg_minutes: number | null; median_minutes: number | null }
    registrations: { decided: number; avg_minutes: number | null; median_minutes: number | null }
  }
  approval_time_by_week: { week: string; decided: number; avg_minutes: number | null }[]
}

/** "45 min", "1 h 30 min", "2 days 4 h"; "—" when there is nothing to measure. */
export function duration(minutes: number | null | undefined): string {
  if (minutes == null || Number.isNaN(minutes)) return '—'
  const m = Math.round(minutes)
  if (m < 1) return 'under a minute'
  if (m < 60) return `${m} min`
  if (m < 24 * 60) {
    const h = Math.floor(m / 60)
    const r = m % 60
    return r ? `${h} h ${r} min` : `${h} h`
  }
  const d = Math.floor(m / (24 * 60))
  const h = Math.round((m - d * 24 * 60) / 60)
  return `${d} day${d === 1 ? '' : 's'}${h ? ` ${h} h` : ''}`
}

/** "Week of 9 Nov". */
export const weekLabel = (iso: string) => day(iso).replace(/ \d{4}$/, '')

/** How long the oldest item has been waiting, e.g. "2 days 4 h". */
export const waitingFor = (oldest: string | null, now = Date.now()) => (oldest ? duration((now - new Date(oldest).getTime()) / 60_000) : null)

export const waitingTotal = (p: ExecutiveDashboard['pending']) => p.registrations + p.requests + p.reactivations + p.closures

/** Share of the agents the platforms list that are governed, leaving out ones retired in the Control Tower. */
export function coveragePercent(c: ExecutiveDashboard['coverage']): number | null {
  const base = c.listed - c.retired
  return base > 0 ? Math.round((c.governed / base) * 100) : null
}

export const TIER_LABEL: Record<Tier, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' }

/** Task 7.4: the approval-time chart's unit. Hours when any week averages two hours or more, else minutes (a week of
 *  5-minute decisions in hours would show every tick as "0 h"). */
export function approvalTimeScale(weeks: { avg_minutes: number | null }[]): { unit: 'min' | 'h'; per: number } {
  const most = Math.max(0, ...weeks.map((w) => w.avg_minutes ?? 0))
  return most >= 120 ? { unit: 'h', per: 60 } : { unit: 'min', per: 1 }
}
