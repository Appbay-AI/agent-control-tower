// Task 4.6: who sees Approve, Reject and Withdraw on a waiting request to switch an agent back on.
import { describe, expect, it } from 'vitest'
import type { AgentReactivation } from '@/lib/types'
import { reactivationChoices } from './Reactivation'

const pending = { id: 'r1', requested_by: 'asker', required_approvals: 2 } as AgentReactivation

describe('reactivation choices (task 4.6)', () => {
  it('the asker can only withdraw; another approver can approve or reject', () => {
    expect(reactivationChoices({ pending, approvals: [], userId: 'asker', canApprove: true, isAdmin: true }))
      .toMatchObject({ canApprove: false, canReject: false, canWithdraw: true })
    expect(reactivationChoices({ pending, approvals: [], userId: 'ravi', canApprove: true, isAdmin: false }))
      .toMatchObject({ canApprove: true, canReject: true, canWithdraw: false })
  })

  it('someone who already approved waits for a second person; someone without the right sees nothing', () => {
    const approvals = [{ reactivation_id: 'r1', agent_id: 'a', approver_id: 'ravi', note: null, approved_at: '' }]
    expect(reactivationChoices({ pending, approvals, userId: 'ravi', canApprove: true, isAdmin: false }))
      .toMatchObject({ canApprove: false, alreadyApproved: true, approvalsSoFar: 1 })
    expect(reactivationChoices({ pending, approvals, userId: 'lucy', canApprove: false, isAdmin: false }))
      .toMatchObject({ canApprove: false, canReject: false, canWithdraw: false })
    expect(reactivationChoices({ pending: null, approvals: [], userId: 'x', canApprove: true, isAdmin: true }).canApprove).toBe(false)
  })
})
