import type { Agent, AgentRegistration, AppRole, RegistrationDecisionRow } from '@/lib/types'

/**
 * What the signed-in person may do with an agent. Mirrors the database rules so the screen offers
 * only actions that will succeed; the database still enforces every rule on its own.
 */
export function agentPermissions(params: {
  agent: Agent
  userId: string
  roles: AppRole[]
  scopeDepartmentIds: string[]
  pending: AgentRegistration | null
  decisions: RegistrationDecisionRow[]
}) {
  const { agent: a, userId, roles, scopeDepartmentIds, pending, decisions } = params
  const isAdmin = roles.includes('admin')
  const isOwnerish = [a.business_owner_id, a.technical_owner_id, a.created_by].includes(userId)
  const inScope = roles.includes('approver') && a.department_id !== null && scopeDepartmentIds.includes(a.department_id)

  const alreadyDecided = pending ? decisions.some((d) => d.registration_id === pending.id && d.approver_id === userId) : false
  const decidedBefore = pending ? decisions.filter((d) => d.registration_id === pending.id && d.decision === 'approve').length : 0

  return {
    canEdit: a.status === 'proposed' && !pending && (isAdmin || isOwnerish),
    canSubmit: a.status === 'proposed' && !pending && (isAdmin || isOwnerish),
    canDecide: Boolean(pending) && (isAdmin || inScope) && !isOwnerish && pending?.submitted_by !== userId && !alreadyDecided,
    alreadyDecided,
    approvalsSoFar: decidedBefore,
    canGoLive: a.status === 'approved' && (isAdmin || [a.business_owner_id, a.technical_owner_id].includes(userId)),
    canReview: ['approved', 'live', 'suspended'].includes(a.status) && (isAdmin || a.business_owner_id === userId || inScope),
    canRetire: a.status !== 'retired' && (isAdmin || a.business_owner_id === userId),
    canManageKeys: isAdmin || isOwnerish,
    /** Task 4.1: the kill switch (same rule as can_suspend_agent in the database). */
    canSuspend: isAdmin || [a.business_owner_id, a.technical_owner_id].includes(userId) || inScope,
    /** Task 4.6: approve switching it back on (can_approve_reactivation; never the person who asked). */
    canApproveReactivation: isAdmin || inScope,
    /** Why submission would fail, so the button can explain instead of erroring. */
    submitBlockers: [
      !a.business_owner_id && 'a business owner',
      !a.purpose_statement.trim() && 'a purpose statement',
      !a.department_id && 'a department',
    ].filter(Boolean) as string[],
  }
}
