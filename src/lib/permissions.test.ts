import { agentPermissions } from '@/lib/permissions'
import type { Agent, AgentRegistration, AppRole } from '@/lib/types'

const base = {
  id: 'a1', agent_code: 'AGT-0001', name: 'Bot', description: null, version: null, origin: 'internal', vendor_name: null,
  framework: 'other', business_owner_id: 'owner', technical_owner_id: 'tech', department_id: 'payments', cost_centre: null,
  purpose_statement: 'Do one thing', in_scope_actions: [], out_of_scope_actions: [], systems_accessed: [],
  data_classifications: [], credential_type: null, credential_owner: null, autonomy_level: 1, value_threshold: null,
  threshold_currency: 'GBP', volume_threshold: null, risk_tier: 'medium', regulatory_flags: [], status: 'proposed',
  approved_by: null, approved_at: null, last_review_date: null, next_review_date: null, registration_source: 'manual',
  control_endpoint: null, silent_after_minutes: null, created_by: 'owner', created_at: '', updated_at: '',
} satisfies Agent

const pending: AgentRegistration = {
  id: 'r1', agent_id: 'a1', submitted_by: 'owner', submitted_at: '', status: 'pending', required_approvals: 1,
  decided_at: null, decision_reason: null,
}

const perms = (userId: string, roles: AppRole[], over: Partial<Agent> = {}, reg: AgentRegistration | null = null, scopes = ['payments']) =>
  agentPermissions({ agent: { ...base, ...over }, userId, roles, scopeDepartmentIds: scopes, pending: reg, decisions: [] })

describe('what each person may do with an agent', () => {
  it('owners edit and submit their own proposals', () => {
    expect(perms('owner', ['owner'])).toMatchObject({ canEdit: true, canSubmit: true, canDecide: false })
  })

  it('explains what blocks submission', () => {
    expect(perms('owner', ['owner'], { business_owner_id: null, created_by: 'owner', department_id: null }).submitBlockers)
      .toEqual(['a business owner', 'a department'])
  })

  it('approvers decide only in their departments and never on their own agents', () => {
    expect(perms('approver', ['approver'], {}, pending).canDecide).toBe(true)
    expect(perms('approver', ['approver'], {}, pending, ['lending']).canDecide).toBe(false)
    expect(perms('tech', ['approver'], {}, pending).canDecide).toBe(false)
  })

  it('nothing is editable while waiting for approval', () => {
    expect(perms('owner', ['owner'], {}, pending)).toMatchObject({ canEdit: false, canSubmit: false })
  })

  it('only owners and admins put approved agents live', () => {
    expect(perms('owner', ['owner'], { status: 'approved' }).canGoLive).toBe(true)
    expect(perms('approver', ['approver'], { status: 'approved' }).canGoLive).toBe(false)
    expect(perms('x', ['admin'], { status: 'approved' }).canGoLive).toBe(true)
  })

  it('executives and auditors can look but not act', () => {
    for (const role of ['executive', 'auditor'] as AppRole[]) {
      expect(perms('x', [role], { status: 'live' })).toMatchObject({
        canEdit: false, canSubmit: false, canDecide: false, canGoLive: false, canReview: false, canRetire: false, canManageKeys: false,
      })
    }
  })
})
