import { api } from '@/lib/api'
import { agentPermissions } from '@/lib/permissions'
import { requestPermissions } from '@/lib/requests'
import type { AppRole } from '@/lib/types'

/** Everything the Approvals screen shows, split into what this person can decide and what waits for someone else. */
export async function loadApprovals({ userId, roles, scopeDepartmentIds }: { userId: string; roles: AppRole[]; scopeDepartmentIds: string[] }) {
  const [pending, agents, decisions, departments, profiles, waiting] = await Promise.all([
    api.pendingRegistrations(), api.agents(), api.decisions(), api.departments(), api.allProfiles(), api.actionRequests('pending'),
  ])
  const byId = new Map(agents.map((a) => [a.id, a]))
  // Four-eyes (task 2.10): who has approved what so far.
  const approvals = await api.requestApprovals(waiting.map((r) => r.id))
  const approvedBy = new Map<string, string[]>()
  for (const x of approvals) approvedBy.set(x.request_id, [...(approvedBy.get(x.request_id) ?? []), x.approver_id])
  // Action requests (task 2.4): oldest first, so nothing waits longest unseen.
  const requests = waiting
    .map((req) => ({ req, agent: byId.get(req.agent_id)! }))
    .filter((x) => x.agent)
    .map((x) => ({
      ...x,
      approvedBy: approvedBy.get(x.req.id) ?? [],
      perms: requestPermissions({ request: x.req, agent: x.agent, userId, roles, scopeDepartmentIds, approvedBy: approvedBy.get(x.req.id) ?? [] }),
      // Bulk approval (task 2.10): only low-risk agents' requests that need one approval.
      bulkable: x.agent.risk_tier === 'low' && x.req.required_approvals === 1,
    }))
    .reverse()
  const items = pending
    .map((reg) => ({ reg, agent: byId.get(reg.agent_id)! }))
    .filter((x) => x.agent)
    .map((x) => ({ ...x, perms: agentPermissions({ agent: x.agent, userId, roles, scopeDepartmentIds, pending: x.reg, decisions }) }))
  return {
    myRequests: requests.filter((x) => x.perms.canDecide),
    otherRequests: requests.filter((x) => !x.perms.canDecide),
    mine: items.filter((x) => x.perms.canDecide),
    others: items.filter((x) => !x.perms.canDecide),
    dept: new Map(departments.map((d) => [d.id, d.name])),
    people: new Map(profiles.map((p) => [p.id, p.full_name])),
  }
}

export type Approvals = Awaited<ReturnType<typeof loadApprovals>>

/** Ids of every waiting item on the screen (agent actions and new agents), used to spot what is new. */
export function approvalIds(a: Approvals): string[] {
  return [...a.myRequests, ...a.otherRequests].map((x) => x.req.id).concat([...a.mine, ...a.others].map((x) => x.reg.id))
}

/** How many things are waiting for this person's decision. */
export function waitingForMe(a: Approvals | null): number {
  return a ? a.myRequests.length + a.mine.length : 0
}
