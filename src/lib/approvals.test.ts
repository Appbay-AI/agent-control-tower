import { beforeEach, describe, expect, it, vi } from 'vitest'

// Live re-reads reuse agents, departments and people for up to a minute (the 2-second live-list target).
const calls = { agents: 0, departments: 0, profiles: 0 }
let waitingAgent = 'a1'
vi.mock('@/lib/api', () => ({
  api: {
    agents: async () => { calls.agents++; return [{ id: 'a1', status: 'live', risk_tier: 'low', department_id: 'd1', business_owner_id: null, technical_owner_id: null, created_by: null }] },
    departments: async () => { calls.departments++; return [{ id: 'd1', name: 'Payments' }] },
    allProfiles: async () => { calls.profiles++; return [] },
    pendingRegistrations: async () => [],
    pendingDecisions: async () => [],
    actionRequests: async () => [{ id: 'r1', agent_id: waitingAgent, status: 'pending', required_approvals: 1, assigned_to: null }],
    pendingApprovals: async () => [],
  },
}))

const { forgetLookups, loadApprovals, LOOKUP_TTL_MS } = await import('./approvals')
const who = { userId: 'u1', roles: ['approver' as const], scopeDepartmentIds: ['d1'] }

describe('live re-reads of the approvals list', () => {
  beforeEach(() => { forgetLookups(); calls.agents = calls.departments = calls.profiles = 0; waitingAgent = 'a1'; vi.useRealTimers() })

  it('a first load reads everything; a live re-read within a minute reuses agents, departments and people', async () => {
    await loadApprovals(who)
    await loadApprovals({ ...who, fresh: false })
    await loadApprovals({ ...who, fresh: false })
    expect(calls).toEqual({ agents: 1, departments: 1, profiles: 1 })
    await loadApprovals(who) // a manual refresh reads them again
    expect(calls.agents).toBe(2)
  })

  it('reads them again after a minute, or when a request comes from an agent it does not know', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-03T10:00:00Z') })
    await loadApprovals(who)
    vi.setSystemTime(Date.parse('2026-11-03T10:00:00Z') + LOOKUP_TTL_MS + 1)
    await loadApprovals({ ...who, fresh: false })
    expect(calls.agents).toBe(2)
    waitingAgent = 'a-new'
    await loadApprovals({ ...who, fresh: false })
    expect(calls.agents).toBe(3)
  })
})
