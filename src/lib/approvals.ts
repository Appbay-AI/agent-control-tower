import { api } from '@/lib/api'
import { agentPermissions } from '@/lib/permissions'
import { requestPermissions } from '@/lib/requests'
import type { Agent, AppRole, Department, Profile } from '@/lib/types'

// Agents, departments and people change rarely, but reading them made up most of each live re-read (three of seven reads,
// the agent list the slowest), which pushed the live list past its 2-second target on slow days. A live re-read reuses
// them for up to a minute; a first load or a manual refresh reads them fresh, and so does any re-read that meets an agent
// it does not know yet. The database still checks every decision, so a minute-old agent record can never let one through.
export const LOOKUP_TTL_MS = 60_000
type Lookups = [Agent[], Department[], Profile[]]
let lookups: { at: number; key: string; data: Promise<Lookups> } | null = null

function readLookups(key: string, fresh: boolean, now = Date.now()): Promise<Lookups> {
  if (fresh || !lookups || lookups.key !== key || now - lookups.at > LOOKUP_TTL_MS) {
    const data = Promise.all([api.agents(), api.departments(), api.allProfiles()])
    lookups = { at: now, key, data }
    data.catch(() => { if (lookups?.data === data) lookups = null })
  }
  return lookups.data
}

/** For tests. */
export function forgetLookups() { lookups = null }

/** Everything the Approvals screen shows, split into what this person can decide and what waits for someone else. */
export async function loadApprovals({ userId, roles, scopeDepartmentIds, fresh = true }: {
  userId: string; roles: AppRole[]; scopeDepartmentIds: string[]
  /** false: a live re-read, which may reuse agents, departments and people read in the last minute. */
  fresh?: boolean
}) {
  const key = userId
  let [pending, [agents, departments, profiles], decisions, waiting, approvals] = await Promise.all([
    api.pendingRegistrations(), readLookups(key, fresh), api.decisions(), api.actionRequests('pending'), api.pendingApprovals(),
  ])
  // Something new refers to an agent we have not read yet (just registered or discovered): read them all again.
  const known = new Set(agents.map((a) => a.id))
  if (!fresh && [...waiting.map((r) => r.agent_id), ...pending.map((r) => r.agent_id)].some((id) => !known.has(id))) {
    ;[agents, departments, profiles] = await readLookups(key, true)
  }
  const byId = new Map(agents.map((a) => [a.id, a]))
  // Four-eyes (task 2.10): who has approved what so far.
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
