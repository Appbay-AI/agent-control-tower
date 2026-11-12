// Task 4.4: incidents in plain words.
import { shortSpan } from '@/lib/sla'
import type { Incident, IncidentStatus, RiskTier, RootCause } from '@/lib/types'

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  open: 'Open', contained: 'Contained', resolved: 'Resolved', closed: 'Closed',
}

export const INCIDENT_SOURCE_LABEL: Record<Incident['source'], string> = {
  suspension: 'Agent suspended', agent_report: 'Reported by the agent', integration_report: 'Reported by a connected system',
  user_report: 'Reported in Control Tower',
  reconciliation: 'Found by the reconciliation check',
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

// Task 4.5: the case.
export const ROOT_CAUSE_LABEL: Record<RootCause, string> = {
  model_error: 'The model got it wrong', instructions: 'Instructions or configuration', data_quality: 'Wrong or missing data',
  integration: 'A connected system failed or changed', access: 'Access or permissions too wide', human_error: 'A person\'s action or approval',
  vendor: 'The vendor or platform', other: 'Something else',
}

export const PERSONAL_DATA_LABEL = { yes: 'Yes', no: 'No', unknown: 'Not known yet' } as const

/** What is still missing before the incident can move to `to` (mirrors incident_missing in the database). */
export function missingFor(i: Pick<Incident, 'containment' | 'impact' | 'personal_data' | 'root_cause_category' | 'root_cause' | 'remediation'>,
  to: 'contained' | 'resolved'): string[] {
  const out: string[] = []
  if (!i.containment) out.push('containment')
  if (to === 'resolved') {
    if (!i.impact) out.push('impact')
    if (!i.personal_data) out.push('whether personal data was involved')
    if (!i.root_cause_category) out.push('root cause category')
    if (!i.root_cause) out.push('root cause')
    if (!i.remediation) out.push('remediation')
  }
  return out
}
