import { DATA_LABEL, formatMoney, RISK_LABEL } from '@/lib/format'
import { durationText } from '@/lib/sla'
import type { RoutingRule, RoutingRuleDraft } from '@/lib/types'

export const emptyRule = (priority: number): RoutingRuleDraft => ({
  name: '', priority, is_active: true, agent_id: null, department_id: null, min_amount: null, max_amount: null,
  currency: 'GBP', data_classification: null, min_risk_tier: null, approver_id: '',
  sla_minutes: null, on_overdue: 'reject', overdue_escalate_to: null,
})

/** What happens when nobody decides in time (task 2.9), e.g. "Within 45 minutes, else escalated once to Daniel Okafor". */
export function describeOverdue(r: Pick<RoutingRule, 'sla_minutes' | 'on_overdue' | 'overdue_escalate_to'>, people: Map<string, string>): string {
  const within = r.sla_minutes ? `Within ${durationText(r.sla_minutes)}` : 'Within the default time for its urgency'
  return r.on_overdue === 'escalate' && r.overdue_escalate_to
    ? `${within}, else escalated once to ${people.get(r.overdue_escalate_to) ?? 'an inactive approver'}`
    : `${within}, else it expires and the agent is told no`
}

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
  if (d.sla_minutes != null && (!Number.isInteger(d.sla_minutes) || d.sla_minutes < 1 || d.sla_minutes > 43200)) return 'Time to decide must be a whole number of minutes, from 1 to 43,200 (30 days).'
  if (d.on_overdue === 'escalate' && !d.overdue_escalate_to) return 'Choose who it goes to when nobody decides in time.'
  if (d.on_overdue === 'escalate' && d.overdue_escalate_to === d.approver_id) return 'Escalate to someone other than the rule\'s approver.'
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

/** Task 5.6: who may give the second approval under a rule. A Critical agent's request needs two different approvers
 * (task 2.10): the rule's approver first, then any other approver for the agent's department (never its owners or the
 * person who registered it). */
export interface SecondApprovalContext {
  agents: Map<string, { agent_code: string; risk_tier: string; department_id: string | null; owners: (string | null)[] }>
  departments: Map<string, string>
  people: Map<string, string>
  /** Department id → ids of the active approvers for it. */
  scopes: Map<string, string[]>
}

export interface SecondApproval {
  /** 'always': the rule only matches Critical agents; 'critical': only for a Critical agent's requests; 'never': the rule's one agent is not Critical. */
  when: 'always' | 'critical' | 'never'
  text: string
  /** True when nobody can give it, so such requests wait until they expire. */
  nobody: boolean
}

export function secondApproval(r: Pick<RoutingRule, 'agent_id' | 'department_id' | 'min_risk_tier' | 'approver_id'>,
  ctx: SecondApprovalContext): SecondApproval {
  const agent = r.agent_id ? ctx.agents.get(r.agent_id) : undefined
  if (agent && agent.risk_tier !== 'critical' && r.min_risk_tier !== 'critical') {
    return { when: 'never', nobody: false, text: `Not needed: ${agent.agent_code} is not Critical. If it becomes Critical, any other approver for its department gives it.` }
  }
  const when = r.min_risk_tier === 'critical' ? 'always' : 'critical'
  const lead = when === 'always' ? '' : 'For a Critical agent: '
  const dept = agent ? agent.department_id : r.department_id
  if (!dept) return { when, nobody: false, text: `${lead}any other approver for the agent's department (not its owners).` }
  const deptName = ctx.departments.get(dept) ?? 'its department'
  const others = (ctx.scopes.get(dept) ?? []).filter((id) => id !== r.approver_id && !(agent?.owners ?? []).includes(id))
  const names = others.map((id) => ctx.people.get(id)).filter((n): n is string => Boolean(n)).sort()
  if (names.length === 0) {
    return { when, nobody: true, text: `${lead}nobody else approves for ${deptName}, so such requests wait until they expire. Add another approver for ${deptName}.` }
  }
  return { when, nobody: false, text: `${lead}any other approver for ${deptName}: ${names.join(', ')}${agent ? '' : ' (not the agent\'s owners)'}.` }
}
