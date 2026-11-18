// Task 6.4: the risk dashboard's figures (`risk_dashboard()` in the database) and how they are shown.
type Tier = 'low' | 'medium' | 'high' | 'critical'
export type BreachKind = 'refused' | 'incident' | 'drift' | 'access'
export interface RiskDashboard {
  at: string
  since: string
  heat: ({ department: string; agents: number; open_incidents: number; breaches: number } & Record<Tier, number>)[]
  trend: ({ week: string } & Record<BreachKind, number>)[]
  totals: Record<BreachKind, number>
  top_agents: { id: string; code: string; name: string; status: string; risk_tier: Tier; department: string | null
    incidents: number; open: number; serious: number; last: string }[]
}

export const BREACHES: { kind: BreachKind; label: string; about: string }[] = [
  { kind: 'refused', label: 'Over its limits', about: 'actions refused automatically because they broke the agent’s limits' },
  { kind: 'incident', label: 'Incidents', about: 'incidents opened' },
  { kind: 'drift', label: 'Changed outside', about: 'changes made on the agent platform outside the Control Tower' },
  { kind: 'access', label: 'Access without authority', about: 'people found with access to data the agent has no authority for' },
]

/** Heat-map shade 0 (empty) to 7 for a count, against the largest count on the map. */
export function heatStep(n: number, max: number): number {
  if (n <= 0 || max <= 0) return 0
  return Math.max(1, Math.min(7, Math.ceil((n / max) * 7)))
}
