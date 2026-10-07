import { supabase } from '@/lib/supabase'
import type {
  Agent, AgentApiKey, AgentDraft, IntegrationKey, AgentRegistration, AgentReview, AlertRow, AuditEvent, Department, Profile,
  RegistrationDecision, RegistrationDecisionRow, RegistrationStatus, ReviewOutcome,
} from '@/lib/types'

function db() {
  if (!supabase) throw new Error('The app is not connected to a database yet.')
  return supabase
}

const NOT_VISIBLE = "This record doesn't exist, or you don't have access to it."

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
  profiles: async () => check(await db().from('profiles').select('*').eq('is_active', true).order('full_name')) as Profile[],

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
  revokeKey: async (keyId: string) => check(await db().rpc('revoke_api_key', { p_key_id: keyId })),
}
