// Types that mirror the database (supabase/migrations). Keep in step with the SQL.

export type AppRole = 'admin' | 'approver' | 'owner' | 'executive' | 'auditor'
export type AgentStatus = 'proposed' | 'approved' | 'live' | 'suspended' | 'retired'
export type RiskTier = 'low' | 'medium' | 'high' | 'critical'
export type AgentOrigin = 'internal' | 'vendor'
export type AgentFramework = 'langchain' | 'appian' | 'vendor_embedded' | 'other'
export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted' | 'personal'
export type RegistrationStatus = 'pending' | 'approved' | 'rejected' | 'sent_back'
export type RegistrationDecision = 'approve' | 'reject' | 'send_back'
export type ReviewOutcome = 'no_change' | 'changes_required' | 'retire'
export type AlertKind = 'review_overdue' | 'owner_missing'

export interface Department {
  id: string
  name: string
  cost_centre: string | null
}

export interface Profile {
  id: string
  full_name: string
  email: string | null
  job_title: string | null
  department_id: string | null
  is_active: boolean
}

export interface Agent {
  id: string
  agent_code: string
  name: string
  description: string | null
  version: string | null
  origin: AgentOrigin
  vendor_name: string | null
  framework: AgentFramework
  business_owner_id: string | null
  technical_owner_id: string | null
  department_id: string | null
  cost_centre: string | null
  purpose_statement: string
  in_scope_actions: string[]
  out_of_scope_actions: string[]
  systems_accessed: string[]
  data_classifications: DataClassification[]
  credential_type: string | null
  credential_owner: string | null
  autonomy_level: 1 | 2 | 3 | 4
  value_threshold: number | null
  threshold_currency: string
  volume_threshold: number | null
  risk_tier: RiskTier
  regulatory_flags: string[]
  status: AgentStatus
  approved_by: string | null
  approved_at: string | null
  last_review_date: string | null
  next_review_date: string | null
  registration_source: 'manual' | 'api' | 'discovered'
  control_endpoint: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** Fields an owner may set when proposing or editing (the database grants exactly these). */
export type AgentDraft = Pick<
  Agent,
  | 'name' | 'description' | 'version' | 'origin' | 'vendor_name' | 'framework'
  | 'business_owner_id' | 'technical_owner_id' | 'department_id' | 'cost_centre'
  | 'purpose_statement' | 'in_scope_actions' | 'out_of_scope_actions'
  | 'systems_accessed' | 'data_classifications' | 'credential_type' | 'credential_owner'
  | 'autonomy_level' | 'value_threshold' | 'threshold_currency' | 'volume_threshold'
  | 'risk_tier' | 'regulatory_flags' | 'control_endpoint'
>

export interface AgentRegistration {
  id: string
  agent_id: string
  submitted_by: string | null
  submitted_at: string
  status: RegistrationStatus
  required_approvals: number
  decided_at: string | null
  decision_reason: string | null
}

export interface RegistrationDecisionRow {
  id: string
  registration_id: string
  agent_id: string
  approver_id: string
  decision: RegistrationDecision
  reason: string | null
  decided_at: string
}

export interface AgentReview {
  id: string
  agent_id: string
  reviewer_id: string | null
  reviewed_at: string
  outcome: ReviewOutcome
  notes: string | null
  next_review_date: string | null
}

export interface AlertRow {
  id: string
  kind: AlertKind
  agent_id: string
  message: string
  raised_at: string
  resolved_at: string | null
}

export interface AuditEvent {
  id: number
  seq: number
  occurred_at: string
  actor_id: string | null
  actor_type: 'user' | 'agent' | 'integration' | 'system'
  action: string
  entity_type: string
  entity_id: string | null
  agent_id: string | null
  summary: string | null
  reason: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  hash: string
}

export interface AgentApiKey {
  id: string
  agent_id: string
  key_prefix: string
  created_at: string
  revoked_at: string | null
  last_used_at: string | null
}
