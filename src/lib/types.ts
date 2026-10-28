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
export type AlertKind = 'review_overdue' | 'owner_missing' | 'agent_silent'

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
  must_change_password: boolean
}

/** One row of the admin Users screen (admin_list_users). */
export interface UserRow {
  id: string
  full_name: string
  email: string | null
  job_title: string | null
  department_id: string | null
  is_active: boolean
  must_change_password: boolean
  roles: AppRole[]
  scope_department_ids: string[]
  last_sign_in_at: string | null
  created_at: string
  owned_agents: number
}

export interface UserDraft {
  full_name: string
  email: string
  job_title: string
  department_id: string | null
  roles: AppRole[]
  scope_department_ids: string[]
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
  /** Task 2.11: flag the agent as silent when nothing is heard from it for this many minutes. Null = not watched. */
  silent_after_minutes: number | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** Task 2.11: when the agent was last heard from (any call with its key). */
export interface AgentContact {
  agent_id: string
  last_seen_at: string | null
  last_seen_via: string | null
  last_note: string | null
  watch_from: string | null
}

export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

/** Task 2.11: one entry the agent wrote through the log API. */
export interface AgentLog {
  id: number
  agent_id: string
  level: LogLevel
  event: string | null
  message: string
  details: Record<string, unknown> | null
  request_id: string | null
  occurred_at: string
  received_at: string
  request: { request_code: string } | null
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

export interface IntegrationKey {
  id: string
  name: string
  key_prefix: string
  created_at: string
  revoked_at: string | null
  last_used_at: string | null
}

export interface RoutingRule {
  id: string
  name: string
  priority: number
  is_active: boolean
  agent_id: string | null
  department_id: string | null
  min_amount: number | null
  max_amount: number | null
  currency: string | null
  data_classification: DataClassification | null
  min_risk_tier: RiskTier | null
  approver_id: string
  // Time limit (task 2.9): blank = the default for the request's urgency.
  sla_minutes: number | null
  on_overdue: 'reject' | 'escalate'
  overdue_escalate_to: string | null
}

export interface RequestApproval { request_id: string; approver_id: string; note: string | null; approved_at: string }

export interface BulkResult { id: string; code: string | null; ok: boolean; message: string }

export interface SlaSetting { urgency: ActionUrgency; minutes: number }

export type RoutingRuleDraft = Omit<RoutingRule, 'id'>

export interface RoutingPreview {
  rule_id: string | null
  rule_name: string | null
  approver_id: string | null
  approver_name: string | null
  note: string
  department_approvers: string[]
}

export type ActionRequestStatus = 'pending' | 'approved' | 'rejected' | 'refused' | 'expired' | 'cancelled'
export type ActionUrgency = 'low' | 'normal' | 'high' | 'critical'
export type ActionDecision = 'approve' | 'reject'

/** An action an agent asked to take (tasks 2.1 to 2.4). */
export interface ActionRequest {
  id: string
  request_code: string
  agent_id: string
  action: string
  description: string | null
  target_system: string | null
  reasoning: string | null
  amount: number | null
  currency: string | null
  volume: number
  urgency: ActionUrgency
  details: Record<string, unknown>
  autonomy_level: 1 | 2 | 3 | 4
  value_threshold: number | null
  threshold_currency: string | null
  volume_threshold: number | null
  status: ActionRequestStatus
  decision_source: 'policy' | 'human' | 'timeout' | null
  decision_reason: string
  decided_by: string | null
  decided_at: string | null
  requested_at: string
  assigned_to: string | null
  routing_note: string | null
  hold_reason: string | null
  escalated_by: string | null
  escalated_at: string | null
  escalation_reason: string | null
  // Four-eyes (task 2.10): 2 for Critical agents
  required_approvals: number
  // Time limit (task 2.9)
  due_at: string | null
  sla_minutes: number | null
  sla_escalate_to: string | null
  sla_escalated_at: string | null
}
