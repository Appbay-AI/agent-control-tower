import { supabase } from '@/lib/supabase'
import type {
  AlertEvent, AlertRoute, AlertRouteDraft, AlertRoutePreview,
  ActionDecision, ActionRequest, ActionRequestStatus, ActionUrgency, Agent, AgentApiKey, AgentContact, AgentLog, AgentDraft, IntegrationKey, AgentRegistration, AgentReview, AlertRow, AuditEvent, Department, Profile,
  RegistrationDecision, RegistrationDecisionRow, RegistrationStatus, ReviewOutcome, RoutingPreview, RoutingRule, RoutingRuleDraft,
  AgentEnforcement, AgentPlatformSource, DriftEvent, Incident, MicrosoftCheck, MicrosoftStatus, IncidentSla, IncidentUpdate, AgentReactivation, ReactivationApproval, RiskTier,
  DataAuthorityRow, AgentAccessRow, AuthorityFinding, DataClassification, AgentSuspension, BulkResult, PlatformAgentRow, PlatformConnection, PlatformJob, PlatformRecord, RequestApproval, SlaSetting, UserDraft, UserRow,
} from '@/lib/types'

function db() {
  if (!supabase) throw new Error('The app is not connected to a database yet.')
  return supabase
}

const REQUEST_COLUMNS = 'id, request_code, agent_id, action, description, target_system, reasoning, amount, currency, volume, urgency, '
  + 'details, autonomy_level, value_threshold, threshold_currency, volume_threshold, status, decision_source, decision_reason, '
  + 'decided_by, decided_at, requested_at, assigned_to, routing_note, hold_reason, escalated_by, escalated_at, escalation_reason, '
  + 'due_at, sla_minutes, sla_escalate_to, sla_escalated_at, required_approvals'

const PLATFORM_AGENT_COLUMNS = 'id, connection_id, external_id, name, status, owner_email, owner_name, department, '
  + 'environment, agent_id, first_seen_at, last_seen_at, missing_since'
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
  /** Decisions on registrations still waiting (all the Approvals screen needs), read from the waiting side (task 4.10). */
  pendingDecisions: async () =>
    (check(await db().from('agent_registrations').select('registration_decisions(*)').eq('status', 'pending')) as unknown as
      { registration_decisions: RegistrationDecisionRow[] }[])
      .flatMap((r) => r.registration_decisions)
      .sort((a, b) => a.decided_at.localeCompare(b.decided_at)),
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
    check(await db().from('platform_connections').select('id, kind, name, base_url, secret_set_at, sync_every_minutes, created_at').order('name')) as PlatformConnection[],
  /** The latest job of a kind on a connection, if any. */
  latestPlatformJob: async (connectionId: string, kind: PlatformJob['kind'] = 'check') =>
    check(await db().from('platform_jobs').select(PLATFORM_JOB_COLUMNS).eq('connection_id', connectionId).eq('kind', kind)
      .order('id', { ascending: false }).limit(1).maybeSingle()) as PlatformJob | null,
  platformJob: async (id: number) =>
    check(await db().from('platform_jobs').select(PLATFORM_JOB_COLUMNS).eq('id', id).single()) as PlatformJob,
  startPlatformJob: async (connectionId: string, kind: PlatformJob['kind']) =>
    check(await db().rpc('platform_job_start', { p_connection: connectionId, p_kind: kind })) as number,
  setPlatformSyncInterval: async (connectionId: string, minutes: number | null) =>
    check(await db().rpc('set_platform_sync_interval', { p_connection: connectionId, p_minutes: minutes })),
  // Kill switch (task 4.1)
  suspensions: async (agentId: string) =>
    check(await db().from('agent_suspensions').select('*').eq('agent_id', agentId).order('requested_at', { ascending: false })) as AgentSuspension[],
  enforcements: async (agentId: string) =>
    check(await db().from('agent_enforcements').select('id, agent_id, suspension_id, action, cause, reactivation_id, method, target, status, detail, attempts, next_attempt_at, claimed_at, created_at, finished_at')
      .eq('agent_id', agentId).order('id')) as AgentEnforcement[],
  // Task 4.8: the data-authority matrix and who can use each agent
  dataAuthority: async () => check(await db().from('data_authority').select('job_title, classification')) as DataAuthorityRow[],
  setDataAuthority: async (jobTitle: string, classification: DataClassification, allowed: boolean) => {
    check(await db().rpc('set_data_authority', { p_job_title: jobTitle, p_classification: classification, p_allowed: allowed }))
  },
  knownJobTitles: async () => check(await db().rpc('known_job_titles')) as { job_title: string; people: number }[],
  agentAccess: async (agentId: string) => check(await db().rpc('agent_access', { p_agent: agentId })) as AgentAccessRow[],
  authorityFindings: async () =>
    check(await db().from('agent_authority_findings').select('*').order('first_seen_at', { ascending: false })) as AuthorityFinding[],
  // Task 4.6: switching a suspended agent back on, only through approval
  reactivations: async (agentId?: string) => {
    let q = db().from('agent_reactivations').select('*').order('requested_at', { ascending: false }).limit(200)
    if (agentId) q = q.eq('agent_id', agentId)
    return check(await q) as AgentReactivation[]
  },
  /** Task 5.3: one request to switch an agent back on (the task page emails link to). */
  reactivation: async (id: string) => {
    const row = check(await db().from('agent_reactivations').select('*').eq('id', id).maybeSingle()) as AgentReactivation | null
    if (!row) throw new Error("This request doesn't exist, or you don't have access to it.")
    return row
  },
  pendingReactivations: async () =>
    check(await db().from('agent_reactivations').select('*').eq('status', 'pending').order('requested_at')) as AgentReactivation[],
  reactivationApprovals: async (agentId?: string) => {
    let q = db().from('agent_reactivation_approvals').select('*').order('approved_at')
    if (agentId) q = q.eq('agent_id', agentId)
    return check(await q) as ReactivationApproval[]
  },
  requestReactivation: async (agentId: string, reason: string) =>
    check(await db().rpc('request_reactivation', { p_agent: agentId, p_reason: reason })) as string,
  approveReactivation: async (id: string, note: string | null) =>
    check(await db().rpc('approve_reactivation', { p_reactivation: id, p_note: note })) as 'approved' | 'waiting',
  rejectReactivation: async (id: string, reason: string) => { check(await db().rpc('reject_reactivation', { p_reactivation: id, p_reason: reason })) },
  withdrawReactivation: async (id: string, reason: string | null) => { check(await db().rpc('withdraw_reactivation', { p_reactivation: id, p_reason: reason })) },
  suspendAgent: async (agentId: string, reason: string) => check(await db().rpc('suspend_agent', { p_agent: agentId, p_reason: reason })) as 'suspended' | 'waiting',
  confirmSuspension: async (id: string, note: string | null) => check(await db().rpc('confirm_agent_suspension', { p_suspension: id, p_note: note })),
  withdrawSuspension: async (id: string, reason: string) => check(await db().rpc('withdraw_agent_suspension', { p_suspension: id, p_reason: reason })),
  killSwitchSettings: async () =>
    check(await db().from('kill_switch_settings').select('critical_needs_second').maybeSingle()) as { critical_needs_second: boolean } | null,
  setKillSwitchSettings: async (criticalNeedsSecond: boolean) =>
    check(await db().rpc('set_kill_switch_settings', { p_critical_needs_second: criticalNeedsSecond })),
  /** Task 3.6: the platform each visible agent comes from (agents not listed were registered by hand or through the API). */
  agentPlatformSources: async () => check(await db().rpc('agent_platform_sources')) as AgentPlatformSource[],
  /** Task 3.5: where this agent was found, if it came from a platform. */
  platformRecord: async (agentId: string) =>
    check(await db().rpc('platform_record_for_agent', { p_agent: agentId })) as PlatformRecord | null,
  /** Task 3.3: agents found on connected platforms (admins, executives, auditors). */
  platformAgents: async () =>
    check(await db().from('platform_agents').select(PLATFORM_AGENT_COLUMNS).order('external_id')) as unknown as PlatformAgentRow[],
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
  // Alert routing (task 5.2)
  alertRoutes: async () => check(await db().from('alert_routes').select('*')) as AlertRoute[],
  saveAlertRoute: async (id: string | null, draft: AlertRouteDraft) => {
    const q = id ? db().from('alert_routes').update(draft).eq('id', id) : db().from('alert_routes').insert(draft)
    const row = check(await q.select('id').maybeSingle()) as { id: string } | null
    if (!row) throw new Error('The route was not saved. Only admins can change alert routing.')
    return row
  },
  deleteAlertRoute: async (id: string) => check(await db().from('alert_routes').delete().eq('id', id)),
  previewAlertRoute: async (agentId: string, event: AlertEvent) =>
    check(await db().rpc('preview_alert_route', { p_agent: agentId, p_event: event })) as AlertRoutePreview[],
  // Connect Microsoft (task 3.1, resumed)
  microsoftStatus: async () => check(await db().rpc('microsoft_status')) as MicrosoftStatus,
  microsoftConnectStart: async () => check(await db().rpc('microsoft_connect_start')) as {
    authorize_url: string; client_id: string; redirect_uri: string; scope: string; state: string; code_challenge: string; code_challenge_method: string },
  microsoftDisconnect: async () => { check(await db().rpc('microsoft_disconnect')) },
  microsoftCheckStart: async (testAgent: string | null) => check(await db().rpc('microsoft_check_start', { p_test_agent: testAgent })) as number,
  microsoftCheck: async (id: number) =>
    check(await db().from('microsoft_checks').select('id, requested_by, test_agent, created_at, claimed_at, finished_at, ok, message, results').eq('id', id).single()) as MicrosoftCheck,
  latestMicrosoftCheck: async () =>
    check(await db().from('microsoft_checks').select('id, requested_by, test_agent, created_at, claimed_at, finished_at, ok, message, results')
      .order('id', { ascending: false }).limit(1).maybeSingle()) as MicrosoftCheck | null,
  // Incidents (task 4.4)
  incidents: async (agentId?: string) => {
    let q = db().from('incidents').select('*').order('opened_at', { ascending: false }).limit(500)
    if (agentId) q = q.eq('agent_id', agentId)
    return check(await q) as Incident[]
  },
  incident: async (id: string) => check(await db().from('incidents').select('*').eq('id', id).single()) as Incident,
  incidentUpdates: async (id: string) =>
    check(await db().from('incident_updates').select('*').eq('incident_id', id).order('created_at')) as IncidentUpdate[],
  canWorkIncident: async (id: string) => check(await db().rpc('can_work_incident', { p_incident: id })) as boolean,
  saveIncidentFields: async (id: string, fields: Record<string, string | null>, note: string | null = null) =>
    check(await db().rpc('incident_save_fields', { p_incident: id, p_fields: fields, p_note: note })) as Incident,
  setIncidentStatus: async (id: string, status: Incident['status'], note: string | null = null) =>
    check(await db().rpc('incident_set_status', { p_incident: id, p_status: status, p_note: note })) as Incident,
  setIncidentSeverity: async (id: string, severity: RiskTier, reason: string) =>
    check(await db().rpc('incident_set_severity', { p_incident: id, p_severity: severity, p_reason: reason })) as Incident,
  reassignIncident: async (id: string, owner: string, reason: string) =>
    check(await db().rpc('incident_reassign', { p_incident: id, p_owner: owner, p_reason: reason })) as Incident,
  addIncidentNote: async (id: string, body: string) => { check(await db().rpc('incident_add_note', { p_incident: id, p_body: body })) },
  reportIncident: async (agentId: string, title: string, severity: RiskTier, description: string | null) =>
    check(await db().rpc('report_incident', { p_agent: agentId, p_title: title, p_severity: severity, p_description: description })) as Incident,
  // Task 4.9: closing needs a named approver; drift records
  incidentClosureApprovers: async (id: string) =>
    check(await db().rpc('incident_closure_approvers', { p_incident: id })) as { id: string; full_name: string; job_title: string | null }[],
  requestIncidentClosure: async (id: string, approver: string, note: string | null) =>
    check(await db().rpc('request_incident_closure', { p_incident: id, p_approver: approver, p_note: note })) as Incident,
  decideIncidentClosure: async (id: string, approve: boolean, note: string | null) =>
    check(await db().rpc('decide_incident_closure', { p_incident: id, p_approve: approve, p_note: note })) as Incident,
  incidentsToClose: async (userId: string) =>
    check(await db().from('incidents').select('*').eq('status', 'resolved').eq('closure_approver_id', userId).order('closure_requested_at')) as Incident[],
  /** Task 5.1: alert emails about one agent (who was told what, and whether it went out). */
  agentAlertEmails: async (agentId: string) =>
    check(await db().rpc('agent_alert_emails', { p_agent: agentId })) as { event: string; headline: string; person: string; status: string; at: string }[],
  driftEvents: async (agentId?: string) => {
    let q = db().from('drift_events').select('*').order('detected_at', { ascending: false }).limit(200)
    if (agentId) q = q.eq('agent_id', agentId)
    return check(await q) as DriftEvent[]
  },
  incidentSla: async () => check(await db().from('incident_sla').select('severity, minutes')) as IncidentSla[],
  saveIncidentSla: async (severity: RiskTier, minutes: number) => {
    const row = check(await db().from('incident_sla').update({ minutes }).eq('severity', severity).select('severity').maybeSingle())
    if (!row) throw new Error('Not saved. Only admins can change incident time limits.')
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
  // Read from the waiting requests' side, so the database checks only their approvals, not every approval ever made.
  pendingApprovals: async () =>
    (check(await db().from('action_requests').select('id, action_request_approvals(request_id, approver_id, note, approved_at)')
      .eq('status', 'pending')) as unknown as { action_request_approvals: RequestApproval[] }[])
      .flatMap((r) => r.action_request_approvals)
      .sort((a, b) => a.approved_at.localeCompare(b.approved_at)),
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
