// Task 6.8: the audit view (`audit_search`, `audit_record_export`, `audit_facets`).
import { when } from '@/lib/format'

type Json = Record<string, unknown> | null
export interface AuditEntry {
  seq: number; at: string; actor_type: 'user' | 'agent' | 'integration' | 'system'; actor_id: string | null; actor: string | null
  action: string; entity_type: string; entity_id: string | null; agent_id: string | null; agent: string | null
  summary: string | null; reason: string | null; before: Json; after: Json; hash: string; prev_hash: string
}
export interface AuditPage { total: number; rows: AuditEntry[]; next_before_seq: number | null; limit: number }
export interface AuditFilters {
  query?: string; from?: string; to?: string; actorType?: string; agent?: string; entity?: string; action?: string
}

const ENTITY: Record<string, string> = {
  agents: 'Agent', action_requests: 'Action request', action_request_approvals: 'Request approval', incidents: 'Incident',
  incident_updates: 'Incident update', agent_api_keys: 'Agent key', alerts: 'Alert', profiles: 'Person', user_roles: 'Role',
  agent_registrations: 'Registration', registration_decisions: 'Registration decision', routing_rules: 'Routing rule',
  agent_suspensions: 'Suspension', approver_scopes: 'Approver department', integration_keys: 'Integration key',
  data_authority: 'Data authority', platform_connections: 'Platform connection', agent_reactivations: 'Switch back on',
  agent_reactivation_approvals: 'Switch-back-on approval', alert_routes: 'Alert route', agent_reviews: 'Review',
  drift_events: 'Change outside', evidence_pack: 'Evidence pack', platform_agents: 'Platform agent', audit_events: 'Audit trail',
  microsoft_connection: 'Microsoft connection',
}
export const entityLabel = (t: string) => ENTITY[t] ?? t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
export const ACTOR_LABEL: Record<AuditEntry['actor_type'], string> = { user: 'Person', agent: 'Agent', integration: 'Integration', system: 'The system' }
export const actorText = (e: Pick<AuditEntry, 'actor' | 'actor_type'>) => e.actor ?? ACTOR_LABEL[e.actor_type]

const NOISE = new Set(['updated_at', 'created_at'])
/** What an update changed: each field whose value differs between before and after. */
export function changedFields(e: Pick<AuditEntry, 'before' | 'after'>): { field: string; from: unknown; to: unknown }[] {
  if (!e.before || !e.after) return []
  const keys = [...new Set([...Object.keys(e.before), ...Object.keys(e.after)])].filter((k) => !NOISE.has(k)).sort()
  return keys.filter((k) => JSON.stringify(e.before![k]) !== JSON.stringify(e.after![k])).map((k) => ({ field: k, from: e.before![k], to: e.after![k] }))
}
export const show = (v: unknown) => (v == null ? '—' : typeof v === 'string' ? v : JSON.stringify(v))

export function auditCsv(rows: AuditEntry[]): string {
  const q = (v: unknown) => { const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const head = ['Entry', 'When (UTC)', 'Exact time (UTC)', 'Actor type', 'Actor', 'Action', 'Record type', 'Record ID', 'Agent', 'Summary', 'Reason', 'Hash', 'Previous hash', 'Before', 'After']
  return [head, ...rows.map((e) => [e.seq, when(e.at), e.at, ACTOR_LABEL[e.actor_type], e.actor, e.action, entityLabel(e.entity_type), e.entity_id,
    e.agent, e.summary, e.reason, e.hash, e.prev_hash, e.before, e.after])].map((l) => l.map(q).join(',')).join('\r\n') + '\r\n'
}
