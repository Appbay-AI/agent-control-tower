// Task 6.7 (R5.4): the personal-data access mismatch report (`pii_mismatch_report(personal_only)`).
import { DATA_LABEL, day, ROLE_LABEL } from '@/lib/format'
import type { DataClassification } from '@/lib/types'

export interface MismatchRow {
  agent_id: string; agent: string; agent_status: string; department: string | null; data: DataClassification[]
  email: string; name: string | null; role: string | null; ct_roles: string[]; ct_user: boolean; active: boolean | null
  how: string[]; missing: DataClassification[]; authorised_roles: string[]; since: string
}
export interface MismatchReport {
  at: string; personal_only: boolean; total: number; people: number; agents: number
  rows: MismatchRow[]
  by_role: { role: string; mismatches: number; people: number }[]
  by_kind: Partial<Record<DataClassification, number>>
  matrix: Partial<Record<DataClassification, string[]>>
}

/** "Everyone" for the matrix's "*", otherwise the role names; "No role is authorised" when none is. */
export const rolesText = (roles: string[]) => (roles.length === 0 ? 'No role is authorised' : roles.map((r) => (r === '*' ? 'Everyone' : r)).join(', '))
export const kindsText = (k: DataClassification[]) => k.map((x) => DATA_LABEL[x] ?? x).join(', ')
/** The person's standing in the Control Tower: their roles, or that they are not a user (or are deactivated). */
export function ctText(r: Pick<MismatchRow, 'ct_user' | 'active' | 'ct_roles'>): string {
  if (!r.ct_user) return 'Not a Control Tower user'
  const roles = r.ct_roles.map((x) => ROLE_LABEL[x as keyof typeof ROLE_LABEL] ?? x).join(', ') || 'No roles'
  return r.active === false ? `${roles} (deactivated)` : roles
}

export function mismatchCsv(rows: MismatchRow[]): string {
  const q = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const head = ['Person', 'Email', 'Role (job title)', 'Control Tower roles', 'Agent', 'Department', 'How they have access', 'Lacks authority for', 'Roles that may see it', 'Since (UTC)']
  return [head, ...rows.map((r) => [r.name, r.email, r.role ?? 'No job title', ctText(r), r.agent, r.department, r.how.join('; '),
    kindsText(r.missing), rolesText(r.authorised_roles), day(r.since)])].map((l) => l.map(q).join(',')).join('\r\n') + '\r\n'
}
