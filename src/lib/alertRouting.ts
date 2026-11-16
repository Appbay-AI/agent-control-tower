// Task 5.2: alert routing. Who gets each alert email (task 5.1): an agent's own routes, else its department's, else the
// default route.
import type { AlertEvent, AlertRoute, AlertRouteDraft } from '@/lib/types'

export const ALERT_EVENTS: { key: AlertEvent; label: string }[] = [
  { key: 'suspended', label: 'Suspended' },
  { key: 'reactivated', label: 'Switched back on' },
  { key: 're_quarantined', label: 'Switched on outside Control Tower, blocked again' },
  { key: 'enforcement_pending', label: 'Not stopped everywhere yet' },
  { key: 'discovered', label: 'Found on a platform, not registered' },
  { key: 'missing_at_source', label: 'Missing from its platform' },
  { key: 'access_without_authority', label: 'Access without authority (incl. personal data)' },
]
const LABEL = new Map(ALERT_EVENTS.map((e) => [e.key as string, e.label]))
export const eventLabel = (k: string) => LABEL.get(k) ?? k

export const emptyRoute = (): AlertRouteDraft => ({
  name: '', scope: 'department', department_id: null, agent_id: null, events: [], to_admins: false, to_business_owner: true,
  to_technical_owner: false, people: [], also_default: true, is_active: true,
})

/** Checked in this order: agent routes, department routes, the default route last. */
export function orderRoutes(routes: AlertRoute[], names: { agents: Map<string, string>; departments: Map<string, string> }): AlertRoute[] {
  const lvl = { agent: 0, department: 1, default: 2 } as const
  const target = (r: AlertRoute) => (r.agent_id ? names.agents.get(r.agent_id) : r.department_id ? names.departments.get(r.department_id) : '') ?? ''
  return [...routes].sort((a, b) => lvl[a.scope] - lvl[b.scope] || target(a).localeCompare(target(b)) || a.name.localeCompare(b.name))
}

export function describeTarget(r: Pick<AlertRoute, 'scope' | 'agent_id' | 'department_id'>, names: { agents: Map<string, string>; departments: Map<string, string> }): string {
  if (r.scope === 'agent') return `Agent ${names.agents.get(r.agent_id ?? '') ?? 'unknown'}`
  if (r.scope === 'department') return `Department: ${names.departments.get(r.department_id ?? '') ?? 'unknown'}`
  return 'Every agent without a route of its own or of its department'
}

export function describeEvents(events: string[]): string {
  return events.length === 0 ? 'All alerts' : events.map(eventLabel).join(', ')
}

/** "Every admin, the business owner, Daniel Okafor, plus everyone on the default route". */
export function describeRecipients(r: Pick<AlertRoute, 'scope' | 'to_admins' | 'to_business_owner' | 'to_technical_owner' | 'people' | 'also_default'>,
  people: Map<string, string>): string {
  const parts = [
    ...(r.to_admins ? ['every admin'] : []),
    ...(r.to_business_owner ? ['the business owner'] : []),
    ...(r.to_technical_owner ? ['the technical owner'] : []),
    ...r.people.map((id) => people.get(id) ?? 'an inactive person'),
  ]
  const text = parts.length ? parts.join(', ') : 'nobody'
  const all = text[0].toUpperCase() + text.slice(1)
  return r.scope !== 'default' && r.also_default ? `${all}, plus everyone on the default route` : all
}

/** Why a route cannot be saved, or null. */
export function routeProblem(d: AlertRouteDraft): string | null {
  if (!d.name.trim()) return 'Give the route a name.'
  if (d.scope === 'department' && !d.department_id) return 'Choose the department.'
  if (d.scope === 'agent' && !d.agent_id) return 'Choose the agent.'
  if (!d.to_admins && !d.to_business_owner && !d.to_technical_owner && d.people.length === 0) return 'Choose at least one person to send to.'
  return null
}
