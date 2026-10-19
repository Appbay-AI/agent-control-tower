import { formatMoney } from '@/lib/format'
import type { ActionRequest, ActionRequestStatus, ActionUrgency, Agent, AppRole } from '@/lib/types'

export const REQUEST_STATUS_LABEL: Record<ActionRequestStatus, string> = {
  pending: 'Waiting for a decision',
  approved: 'Approved',
  rejected: 'Rejected',
  refused: 'Refused by policy',
  expired: 'Expired',
  cancelled: 'Cancelled',
}

export const URGENCY_LABEL: Record<ActionUrgency, string> = { low: 'Low', normal: 'Normal', high: 'High', critical: 'Critical' }

/** "payment.release" → "Payment release". */
export function humanAction(action: string): string {
  const words = action.replace(/[._-]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : 'Act'
}

/**
 * What the agent wants, in one line: "Release payment to Acme Steel". Uses the agent's own description when it gave one,
 * otherwise the action code.
 */
export function whatItWants(r: Pick<ActionRequest, 'action' | 'description'>): string {
  const text = r.description?.trim() || humanAction(r.action)
  return text.replace(/\.$/, '')
}

/** "Payment Release Assistant wants to release payment to Acme Steel"; without a description, "… asks for: Payment release". */
export function headline(r: Pick<ActionRequest, 'action' | 'description'>, agentName: string): string {
  if (!r.description?.trim()) return `${agentName} asks for: ${humanAction(r.action)}`
  const what = whatItWants(r)
  // Lower-case the first letter so the sentence reads on, but keep acronyms such as "FX" as they are.
  const joined = /^[A-Z][a-z]/.test(what) ? what[0].toLowerCase() + what.slice(1) : what
  return `${agentName} wants to ${joined}`
}

export function requestAmount(r: Pick<ActionRequest, 'amount' | 'currency'>): string | null {
  return r.amount == null ? null : formatMoney(r.amount, r.currency ?? 'GBP')
}

/** The agent's extra details as label/value pairs; nested values are shown as compact JSON. */
export function detailEntries(details: Record<string, unknown> | null | undefined): [string, string][] {
  return Object.entries(details ?? {}).map(([k, v]) => [
    humanAction(k),
    v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v),
  ])
}

/**
 * May the signed-in person decide this request? Mirrors can_decide_request in the database, so the screen offers only
 * actions that will succeed; the database still enforces every rule on its own.
 */
export function requestPermissions(params: {
  request: Pick<ActionRequest, 'status' | 'assigned_to'>
  agent: Pick<Agent, 'business_owner_id' | 'technical_owner_id' | 'created_by' | 'department_id'>
  userId: string
  roles: AppRole[]
  scopeDepartmentIds: string[]
}): { canDecide: boolean; whyNot: string | null } {
  const { request: r, agent: a, userId, roles, scopeDepartmentIds } = params
  if (r.status !== 'pending') return { canDecide: false, whyNot: null }
  if ([a.business_owner_id, a.technical_owner_id, a.created_by].includes(userId)) {
    return { canDecide: false, whyNot: 'You own or created this agent, so someone else must decide.' }
  }
  if (!roles.includes('approver')) return { canDecide: false, whyNot: 'Only approvers decide on agent actions.' }
  if (r.assigned_to) {
    return r.assigned_to === userId ? { canDecide: true, whyNot: null } : { canDecide: false, whyNot: 'It is assigned to someone else.' }
  }
  const inScope = a.department_id !== null && scopeDepartmentIds.includes(a.department_id)
  return inScope ? { canDecide: true, whyNot: null } : { canDecide: false, whyNot: "You don't approve for this agent's department." }
}
