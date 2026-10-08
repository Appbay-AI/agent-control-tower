import type { AppRole, UserDraft, UserRow } from '@/lib/types'

export const ROLE_ORDER: AppRole[] = ['owner', 'approver', 'executive', 'auditor', 'admin']

export const emptyUserDraft = (): UserDraft => ({
  full_name: '', email: '', job_title: '', department_id: null, roles: ['owner'], scope_department_ids: [],
})

export const draftFromUser = (u: UserRow): UserDraft => ({
  full_name: u.full_name, email: u.email ?? '', job_title: u.job_title ?? '', department_id: u.department_id,
  roles: [...u.roles], scope_department_ids: [...u.scope_department_ids],
})

/** The same checks the database makes, so the form can say what is wrong before saving. */
export function userDraftProblem(d: UserDraft, isNew: boolean): string | null {
  if (!d.full_name.trim()) return "Enter the person's name."
  if (isNew && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email.trim())) return 'Enter a valid email address.'
  if (d.roles.length === 0) return 'Choose at least one role. Without a role the person sees nothing.'
  if (d.roles.includes('approver') && d.scope_department_ids.length === 0)
    return 'Choose at least one department this approver approves for.'
  return null
}

export function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}

/** A ready-to-send message with everything the person needs to sign in the first time. */
export function signInMessage(name: string, email: string, password: string, appUrl: string): string {
  const first = name.trim().split(/\s+/)[0] || 'there'
  return [
    `Hi ${first},`,
    '',
    'Your Agent Control Tower account is ready.',
    '',
    `Sign in at: ${appUrl}`,
    `Email: ${email}`,
    `Temporary password: ${password}`,
    '',
    "You'll be asked to choose your own password when you first sign in. The temporary one stops working after that.",
  ].join('\n')
}

export type UserState = 'active' | 'waiting' | 'deactivated'

export function userState(u: Pick<UserRow, 'is_active' | 'must_change_password'>): UserState {
  if (!u.is_active) return 'deactivated'
  return u.must_change_password ? 'waiting' : 'active'
}
