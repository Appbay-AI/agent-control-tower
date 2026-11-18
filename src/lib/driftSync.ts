// Task 6.6 (R5.1, R5.2): the drift report (`drift_report(from, to)`) and sync health (`sync_health(days)`).
import { DRIFT_LABEL } from '@/components/DriftList'
import { when } from '@/lib/format'
import type { DriftKind } from '@/lib/types'

export interface DriftRow {
  id: string; at: string; agent_id: string; agent: string; agent_status: string; department: string | null
  platform: string | null; external_id: string | null; kind: DriftKind; expected: string; observed: string; actor: string
  action: string; result: string; incident: string | null; incident_id: string | null
  enforcement: { status: string; attempts: number } | null
}
export interface DriftReport {
  period: { from: string; to: string; timezone: string }
  cap: number
  total: number
  rows: DriftRow[]
  by_kind: Partial<Record<DriftKind, number>>
  by_actor: { actor: string; changes: number }[]
  by_agent: { agent_id: string; agent: string; changes: number; last: string }[]
}
export interface PlatformHealth {
  id: string; name: string; kind: string; every_minutes: number | null
  last_ok: { at: string; message: string } | null
  last_failure: { at: string; message: string } | null
  failing_now: number
  day: { syncs: number; failed: number }
  period: { syncs: number; failed: number; not_finished: number; new: number; back: number; missing: number; status_changed: number; linked: number; registered: number }
  reconciliations: { checks: number; failed: number; reblocked: number }
  agents: { listed: number; missing: number; linked: number; first_seen: number }
  by_day: { day: string; syncs: number; failed: number; changes: number }[]
}
export interface SyncHealth {
  at: string; days: number; since: string
  platforms: PlatformHealth[]
  notable: { id: number; platform: string; kind: 'sync' | 'reconcile'; at: string; ok: boolean | null; message: string | null }[]
}

/** Healthy, failing (the latest fetches failed), or overdue (no good fetch for over twice the interval, or ever). */
export function healthState(p: Pick<PlatformHealth, 'failing_now' | 'last_ok' | 'every_minutes'>, now = Date.now()): { state: 'healthy' | 'failing' | 'overdue' | 'off'; text: string } {
  if (!p.every_minutes) return { state: 'off', text: 'Automatic fetching is off' }
  if (p.failing_now > 0) return { state: 'failing', text: `The last ${p.failing_now === 1 ? 'fetch' : `${p.failing_now} fetches`} failed` }
  if (!p.last_ok) return { state: 'overdue', text: 'No good fetch yet' }
  const late = now - Date.parse(p.last_ok.at) > 2 * p.every_minutes * 60_000
  return late ? { state: 'overdue', text: `No good fetch for over ${2 * p.every_minutes} minutes` } : { state: 'healthy', text: 'Fetching on time' }
}

/** The drift rows as CSV (Excel opens it), UTC times, the same columns as the screen. */
export function driftCsv(rows: DriftRow[]): string {
  const q = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = ['Detected (UTC)', 'Agent', 'Department', 'Platform', 'Platform ID', 'What changed', 'Expected', 'Found', 'Who', 'What Control Tower did', 'Result', 'Incident']
  return [head, ...rows.map((r) => [when(r.at), r.agent, r.department, r.platform, r.external_id, DRIFT_LABEL[r.kind] ?? r.kind,
    r.expected, r.observed, r.actor, r.action, r.result, r.incident])].map((l) => l.map(q).join(',')).join('\r\n') + '\r\n'
}
