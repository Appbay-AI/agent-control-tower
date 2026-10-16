import { DATA_LABEL, formatMoney, RISK_LABEL } from '@/lib/format'
import type { RoutingRule, RoutingRuleDraft } from '@/lib/types'

export const emptyRule = (priority: number): RoutingRuleDraft => ({
  name: '', priority, is_active: true, agent_id: null, department_id: null, min_amount: null, max_amount: null,
  currency: 'GBP', data_classification: null, min_risk_tier: null, approver_id: '',
})

/** The rule's conditions in one plain sentence, e.g. "Payments · GBP 1,000,000.00 and above · touches Personal data". */
export function describeConditions(r: Pick<RoutingRule, 'agent_id' | 'department_id' | 'min_amount' | 'max_amount' | 'currency' | 'data_classification' | 'min_risk_tier'>,
  names: { agents: Map<string, string>; departments: Map<string, string> }): string {
  const parts: string[] = []
  if (r.agent_id) parts.push(`Agent ${names.agents.get(r.agent_id) ?? 'unknown'}`)
  if (r.department_id) parts.push(names.departments.get(r.department_id) ?? 'Unknown department')
  const cur = r.currency ?? 'GBP'
  if (r.min_amount != null && r.max_amount != null) parts.push(`${formatMoney(r.min_amount, cur)} up to ${formatMoney(r.max_amount, cur)}`)
  else if (r.min_amount != null) parts.push(`${formatMoney(r.min_amount, cur)} and above`)
  else if (r.max_amount != null) parts.push(`below ${formatMoney(r.max_amount, cur)}`)
  if (r.data_classification) {
    const label = DATA_LABEL[r.data_classification]
    parts.push(`touches ${/data$/i.test(label) ? label : `${label} data`}`)
  }
  if (r.min_risk_tier) parts.push(`${RISK_LABEL[r.min_risk_tier]} risk or higher`)
  return parts.length ? parts.join(' · ') : 'Every waiting request'
}

/** Same checks as the database, so the form explains a problem before saving. */
export function ruleProblem(d: RoutingRuleDraft): string | null {
  if (!d.name.trim()) return 'Give the rule a name, e.g. "Large payments".'
  if (!d.approver_id) return 'Choose who approves.'
  if ((d.min_amount != null || d.max_amount != null) && !/^[A-Z]{3}$/.test(d.currency ?? '')) return 'A value band needs a 3-letter currency, e.g. GBP.'
  if (d.min_amount != null && d.min_amount < 0) return 'The lower amount cannot be negative.'
  if (d.min_amount != null && d.max_amount != null && d.min_amount >= d.max_amount) return 'The "up to" amount must be larger than the "from" amount.'
  if (!Number.isInteger(d.priority) || d.priority < 1 || d.priority > 9999) return 'Priority must be a whole number from 1 to 9999.'
  return null
}

/** Moves one rule up or down and renumbers all of them 10, 20, 30 … so the order is unambiguous. */
export function reorder(rules: Pick<RoutingRule, 'id' | 'priority'>[], id: string, direction: -1 | 1): { id: string; priority: number }[] {
  const list = [...rules]
  const i = list.findIndex((r) => r.id === id)
  const j = i + direction
  if (i < 0 || j < 0 || j >= list.length) return []
  ;[list[i], list[j]] = [list[j], list[i]]
  return list.map((r, k) => ({ id: r.id, priority: (k + 1) * 10 })).filter((r, k) => r.priority !== rules.find((x) => x.id === list[k].id)?.priority)
}
