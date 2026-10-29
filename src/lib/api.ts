import { supabase } from '@/lib/supabase'
import type {
  ActionDecision, ActionRequest, ActionRequestStatus, ActionUrgency, Agent, AgentApiKey, AgentContact, AgentLog, AgentDraft, IntegrationKey, AgentRegistration, AgentReview, AlertRow, AuditEvent, Department, Profile,
  RegistrationDecision, RegistrationDecisionRow, RegistrationStatus, ReviewOutcome, RoutingPreview, RoutingRule, RoutingRuleDraft,
  BulkResult, PlatformConnection, PlatformJob, RequestApproval, SlaSetting, UserDraft, UserRow,
} from '@/lib/types'

function db() {
  if (!supabase) throw new Error('The app is not connected to a database yet.')
  return supabase
}

const REQUEST_COLUMNS = 'id, request_code, agent_id, action, description, target_system, reasoning, amount, currency, volume, urgency, '
  + 'details, autonomy_level, value_threshold, threshold_currency, volume_threshold, status, decision_source, decision_reason, '
  + 'decided_by, decided_at, requested_at, assigned_to, routing_note, hold_reason, escalated_by, escalated_at, escalation_reason, '
  + 'due_at, sla_minutes, sla_escalate_to, sla_escalated_at, required_approvals'

const PLATFORM_JOB_COLUMNS = 'id, connection_id, kind, created_at, claimed_at, finished_at, ok, message, result'

const NOT_VISIBLE ="This record doesn't exist, or you don't have access to it."

/** Throws the database's own message (our SQL raises plain-English errors). */
function check<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    // PGRST116: a single row was expected but none (or several) came back, usually because row-level
    // security hides it from this person. Never show the raw API wording.
    if (res.error.code === 'PGRST116') throw new Error(NOT_VISIBLE)
    throw new Error(res.error.message)
  }
  return res.data as T
}

export const api = {
  departments: async () => check(await db().from('departments').select('*').order('name')) as Department[],
  /** Active people, for owner pickers. */
  profiles: async () => check(await db().from('profiles').select('*').eq('is_active', true).order('full_name')) as Profile[],
  /** Everyone, including deactivated people, for showing names on existing records. */
  allProfiles: async () => check(await db().from('profiles').select('*').order('full_name')) as Profile[],

  agents: async () => check(await db().from('agents').select('*').order('agent_code')) as Agent[],
  agent: async (id: string) => {
    const row = check(await db().from('agents').select('*').eq('id', id).maybeSingle()) as Agent | null
    if (!row) throw new Error("This agent doesn't exist, or you don't have access to it.")
    return row
  },
  approversFor: async (agentId: string) =>
    check(await db().rpc('approvers_for', { p_agent_id: agentId })) as { id: string; full_name: string; job_title: string | null }[],

  createAgent: async (draft: AgentDraft, userId: string) => {
    const row = check(await db().from('agents').insert({ ...draft, created_by: userId }).select('id').maybeSingle()) as { id: string } | null
    if (!row) throw new Error('The agent could not be saved. Check you have the Agent owner role.')
    return row
  },
  updateAgent: async (id: string, draft: Partial<AgentDraft>) => {
    const row = check(await db().from('agents').update(draft).eq('id', id).select('id').maybeSingle()) as { id: string } | null
    // No row back: either it wasn't yours to edit, or your change removed you from it so you can no longer see it.
    if (!row) throw new Error("The change was not saved, or you removed yourself from this agent and can no longer see it. Only the agent's owners and creator can edit it.")
    return row
  },

  submit: async (agentId: string) => check(await db().rpc('submit_agent_for_approval', { p_agent_id: agentId })) as string,
  decide: async (registrationId: string, decision: RegistrationDecision, reason?: string) =>
    check(await db().rpc('decide_registration', {
      p_registration_id: registrationId, p_decision: decision, p_reason: reason ?? null,
    })) as RegistrationStatus,
  goLive: async (agentId: string) => check(await db().rpc('go_live', { p_agent_id: agentId, p_reason: null })),
  retire: async (agentId: string, reason: string) => check(await db().rpc('retire_agent', { p_agent_id: agentId, p_reason: reason })),
  review: async (agentId: string, outcome: ReviewOutcome, notes: string | null) =>
    check(await db().rpc('record_review', { p_agent_id: agentId, p_outcome: outcome, p_notes: notes })) as string | null,

  registrations: async (agentId?: string) => {
    let q = db().from('agent_registrations').select('*').order('submitted_at', { ascending: false })
    if (agentId) q = q.eq('agent_id', agentId)
    return check(await q) as AgentRegistration[]
  },
  pendingRegistrations: async () =>
    check(await db().from('agent_registrations').select('*').eq('status', 'pending').order('submitted_at')) as AgentRegistration[],
  decisions: async (agentId?: string) => {
    let q = db().from('registration_decisions').select('*').order('decided_at')
    if (agentId) q = q.eq('agent_id', agentId)
    return check(await q) as RegistrationDecisionRow[]
  },
  reviews: async (agentId: string) =>
    check(await db().from('agent_reviews').select('*').eq('agent_id', agentId).order('reviewed_at', { ascending: false })) as AgentReview[],
  openAlerts: async () => check(await db().from('alerts').select('*').is('resolved_at', null)) as AlertRow[],
  // Task 2.11: check-ins and the agent log.
  agentContact: async (agentId: string) =>
    check(await db().from('agent_contact').select('*').eq('agent_id', agentId).maybeSingle()) as AgentContact | null,
  agentLogs: async (agentId: string, limit = 50) =>
    check(await db().from('agent_logs')
      .select('id, agent_id, level, event, message, details, request_id, occurred_at, received_at, request:action_requests(request_code)')
      .eq('agent_id', agentId).order('occurred_at', { ascending: false }).order('id', { ascending: false }).limit(limit)) as unknown as AgentLog[],
  setSilenceLimit: async (agentId: string, minutes: number | null) =>
    check(await db().rpc('set_agent_silence_limit', { p_agent: agentId, p_minutes: minutes })),
  activity: async (agentId: string) =>
    check(await db().from('audit_events')
      .select('id, seq, occurred_at, actor_id, actor_type, action, entity_type, entity_id, agent_id, summary, reason, before, after, hash')
      .eq('agent_id', agentId).order('seq', { ascending: false }).limit(100)) as AuditEvent[],

  apiKeys: async (agentId: string) =>
    check(await db().from('agent_api_keys').select('id, agent_id, key_prefix, created_at, revoked_at, last_used_at')
      .eq('agent_id', agentId).order('created_at', { ascending: false })) as AgentApiKey[],
  createApiKey: async (agentId: string) => check(await db().rpc('create_agent_api_key', { p_agent_id: agentId })) as string,
  integrationKeys: async () =>
    check(await db().from('integration_keys').select('id, name, key_prefix, created_at, revoked_at, last_used_at')
      .order('created_at', { ascending: false })) as IntegrationKey[],
  createIntegrationKey: async (name: string) => check(await db().rpc('create_integration_key', { p_name: name })) as string,
  /** Task 3.2: platform connections (admins only; others get an empty list). */
  platformConnections: async () =>
    check(await db().from('platform_connections').select('id, kind, name, base_url, secret_set_at, created_at').order('name')) as PlatformConnection[],
  /** The latest job on a connection, if any. */
  latestPlatformJob: async (connectionId: string) =>
    check(await db().from('platform_jobs').select(PLATFORM_JOB_COLUMNS).eq('connection_id', connectionId)
      .order('id', { ascending: false }).limit(1).maybeSingle()) as PlatformJob | null,
  platformJob: async (id: number) =>
    check(await db().from('platform_jobs').select(PLATFORM_JOB_COLUMNS).eq('id', id).single()) as PlatformJob,
  startPlatformCheck: async (connectionId: string) =>
    check(await db().rpc('platform_job_start', { p_connection: connectionId, p_kind: 'check' })) as number,
  users: async () => check(await db().rpc('admin_list_users')) as UserRow[],
  createUser: async (d: UserDraft) =>
    check(await db().rpc('admin_create_user', {
      p_email: d.email, p_full_name: d.full_name, p_job_title: d.job_title, p_department_id: d.department_id,
      p_roles: d.roles, p_scope_department_ids: d.scope_department_ids,
    })) as { id: string; temporary_password: string },
  updateUser: async (id: string, d: UserDraft) =>
    check(await db().rpc('admin_update_user', {
      p_user_id: id, p_full_name: d.full_name, p_job_title: d.job_title, p_department_id: d.department_id,
      p_roles: d.roles, p_scope_department_ids: d.scope_department_ids,
    })),
  resetPassword: async (id: string) => check(await db().rpc('admin_reset_password', { p_user_id: id })) as string,
  setUserActive: async (id: string, active: boolean, reason: string | null) =>
    check(await db().rpc('admin_set_user_active', { p_user_id: id, p_active: active, p_reason: reason })),
  passwordChanged: async () => check(await db().rpc('password_changed')),

  routingRules: async () =>
    check(await db().from('routing_rules')
      .select('id, name, priority, is_active, agent_id, department_id, min_amount, max_amount, currency, data_classification, min_risk_tier, approver_id, sla_minutes, on_overdue, overdue_escalate_to')
      .order('priority').order('created_at')) as RoutingRule[],
  /** Active people with the Approver role, for the routing screen. */
  approvers: async () => {
    const roles = check(await db().from('user_roles').select('user_id').eq('role', 'approver')) as { user_id: string }[]
    const ids = roles.map((r) => r.user_id)
    if (!ids.length) return [] as Profile[]
    return check(await db().from('profiles').select('*').in('id', ids).eq('is_active', true).order('full_name')) as Profile[]
  },
  saveRoutingRule: async (id: string | null, draft: RoutingRuleDraft) => {
    const q = id ? db().from('routing_rules').update(draft).eq('id', id) : db().from('routing_rules').insert(draft)
    const row = check(await q.select('id').maybeSingle()) as { id: string } | null
    if (!row) throw new Error('The rule was not saved. Only admins can change routing.')
    return row
  },
  // Default time limits by urgency (task 2.9)
  slaSettings: async () => check(await db().from('sla_settings').select('urgency, minutes')) as SlaSetting[],
  saveSlaSetting: async (urgency: ActionUrgency, minutes: number) => {
    const row = check(await db().from('sla_settings').update({ minutes }).eq('urgency', urgency).select('urgency').maybeSingle())
    if (!row) throw new Error('Not saved. Only admins can change time limits.')
  },
  setRulePriorities: async (order: { id: string; priority: number }[]) => {
    for (const { id, priority } of order) check(await db().from('routing_rules').update({ priority }).eq('id', id))
  },
  deleteRoutingRule: async (id: string) => check(await db().from('routing_rules').delete().eq('id', id)),
  previewRouting: async (agentId: string, amount: number | null, currency: string | null) =>
    check(await db().rpc('preview_routing', { p_agent_id: agentId, p_amount: amount, p_currency: currency })) as RoutingPreview,
  reroutePending: async () => check(await db().rpc('reroute_pending_requests')) as number,

  actionRequests: async (status?: ActionRequestStatus) => {
    let q = db().from('action_requests').select(REQUEST_COLUMNS).order('requested_at', { ascending: false }).limit(200)
    if (status) q = q.eq('status', status)
    return check(await q) as unknown as ActionRequest[]
  },
  actionRequest: async (id: string) => {
    const row = check(await db().from('action_requests').select(REQUEST_COLUMNS).eq('id', id).maybeSingle()) as unknown as ActionRequest | null
    if (!row) throw new Error("This request doesn't exist, or you don't have access to it.")
    return row
  },
  // Four-eyes and bulk (task 2.10)
  /** Approvals so far on every waiting request (one query, so the Approvals screen can load it alongside the rest). */
  pendingApprovals: async () =>
    (check(await db().from('action_request_approvals').select('request_id, approver_id, note, approved_at, action_requests!inner(status)')
      .eq('action_requests.status', 'pending').order('approved_at')) as unknown as (RequestApproval & { action_requests: unknown })[])
      .map((x) => ({ request_id: x.request_id, approver_id: x.approver_id, note: x.note, approved_at: x.approved_at })),
  requestApprovals: async (requestIds: string[]) => requestIds.length === 0 ? [] :
    check(await db().from('action_request_approvals').select('request_id, approver_id, note, approved_at')
      .in('request_id', requestIds).order('approved_at')) as RequestApproval[],
  bulkApprove: async (ids: string[], note: string | null) =>
    check(await db().rpc('decide_action_requests_bulk', { p_ids: ids, p_note: note })) as BulkResult[],
  decideRequest: async (id: string, decision: ActionDecision, reason: string | null) =>
    check(await db().rpc('decide_action_request', { p_request_id: id, p_decision: decision, p_reason: reason })) as ActionRequestStatus,
  escalateRequest: async (id: string, to: string, reason: string) =>
    check(await db().rpc('escalate_action_request', { p_request_id: id, p_to: to, p_reason: reason })),
  escalationTargets: async (id: string) =>
    check(await db().rpc('escalation_targets', { p_request_id: id })) as { id: string; full_name: string; job_title: string | null }[],

  revokeKey: async (keyId: string) => check(await db().rpc('revoke_api_key', { p_key_id: keyId })),

  // Phone alerts (task 2.6)
  pushPublicKey: async () => check(await db().rpc('push_public_key')) as string | null,
  pushSubscribe: async (s: { endpoint: string; p256dh: string; auth: string; device: string }) =>
    check(await db().rpc('push_subscribe', { p_endpoint: s.endpoint, p_p256dh: s.p256dh, p_auth: s.auth, p_device: s.device })) as string,
  pushUnsubscribe: async (endpoint: string) => check(await db().rpc('push_unsubscribe', { p_endpoint: endpoint })),
  pushSendTest: async () => check(await db().rpc('push_send_test')),
  // Agent console (task 2.8, demo)
  demoAgentAsk: async (amount: number, supplier: string, reason: string, test: boolean) =>
    check(await db().rpc('demo_agent_ask', { p_amount: amount, p_supplier: supplier, p_reason: reason, p_test: test })) as
      { request_id: string; request_code: string; status: string; reason: string | null },
  demoAgentLog: async () =>
    check(await db().from('demo_agent_events')
      .select('id, request_id, kind, status, may_proceed, reason, at, request:action_requests(request_code, description, amount, status)')
      .order('id', { ascending: false }).limit(60)) as unknown as import('@/lib/agentConsole').ConsoleEvent[],
  // Who was told about a request (tasks 2.6, 2.7 and 2.8)
  requestNotifications: async (requestId: string) =>
    check(await db().rpc('request_notifications', { p_request_id: requestId })) as { channel: string; person: string; status: string; at: string }[],
}
