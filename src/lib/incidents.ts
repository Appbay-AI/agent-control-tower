// Task 4.4: incidents in plain words.
import { shortSpan } from '@/lib/sla'
import type { Incident, IncidentStatus, RiskTier } from '@/lib/types'

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  open: 'Open', contained: 'Contained', resolved: 'Resolved', closed: 'Closed',
}

export const INCIDENT_SOURCE_LABEL: Record<Incident['source'], string> = {
  suspension: 'Agent suspended', agent_report: 'Reported by the agent', integration_report: 'Reported by a connected system',
}

export const SEVERITIES: RiskTier[] = ['critical', 'high', 'medium', 'low']

export const isOpen = (i: Pick<Incident, 'status'>) => i.status === 'open' || i.status === 'contained'

export type IncidentDue = { text: string; overdue: boolean } | null

/** "Resolve within 23 h" or "Overdue by 2 h" while open; null once resolved or closed. */
export function incidentDue(i: Pick<Incident, 'status' | 'due_at'>, now = Date.now()): IncidentDue {
  if (!isOpen(i)) return null
  const left = new Date(i.due_at).getTime() - now
  return left > 0 ? { text: `Resolve within ${shortSpan(left)}`, overdue: false } : { text: `Overdue by ${shortSpan(left)}`, overdue: true }
}

/** Open first (most overdue first), then the rest, newest first. */
export function sortIncidents(list: Incident[]): Incident[] {
  return [...list].sort((a, b) => {
    const ao = isOpen(a), bo = isOpen(b)
    if (ao !== bo) return ao ? -1 : 1
    if (ao) return a.due_at.localeCompare(b.due_at)
    return b.opened_at.localeCompare(a.opened_at)
  })
}
