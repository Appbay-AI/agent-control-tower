// Task 6.5: the operational dashboard ("My work"): `my_dashboard()` in the database, for the signed-in person only.
import { duration } from '@/lib/dashboard'

type Tier = 'low' | 'medium' | 'high' | 'critical'
export interface MyWork {
  at: string
  me: string | null
  approvals: {
    requests: { id: string; code: string; action: string; amount: number | null; currency: string | null; agent: string; agent_id: string
      requested_at: string; due_at: string | null; assigned: boolean }[]
    registrations: { id: string; agent: string; agent_id: string; risk_tier: Tier; submitted_at: string }[]
    reactivations: { id: string; agent: string; agent_id: string; reason: string; requested_at: string }[]
    closures: { id: string; code: string; title: string; agent: string; agent_id: string; requested_at: string }[]
  }
  agents: { id: string; code: string; name: string; status: string; risk_tier: Tier; role: string; next_review: string | null
    review_overdue: boolean; review_required: string | null; open_incidents: number; pending_requests: number }[]
  breaches: { kind: 'request' | 'incident' | 'review'; id: string; title: string; agent: string; due: string; link: string
    severity?: Tier; owner?: boolean }[]
}

export const waitingCount = (a: MyWork['approvals']) => a.requests.length + a.registrations.length + a.reactivations.length + a.closures.length

/** "Overdue by 2 h 10 min", "Due in 45 min", or for a date (reviews) "Overdue by 5 days". */
export function dueText(due: string | null, now = Date.now()): string {
  if (!due) return 'No deadline'
  const t = due.length === 10 ? Date.parse(`${due}T00:00:00Z`) : Date.parse(due)
  const mins = (t - now) / 60_000
  if (due.length === 10) {
    const days = Math.floor(-mins / (24 * 60))
    return days >= 1 ? `Overdue by ${days} day${days === 1 ? '' : 's'}` : 'Due today'
  }
  return mins < 0 ? `Overdue by ${duration(-mins)}` : `Due in ${duration(mins)}`
}

export const BREACH_LABEL: Record<MyWork['breaches'][number]['kind'], string> = {
  request: 'Decision overdue', incident: 'Incident past due', review: 'Review overdue',
}
