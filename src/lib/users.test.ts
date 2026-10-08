import { describe, expect, it } from 'vitest'
import { emptyUserDraft, signInMessage, toggle, userDraftProblem, userState } from '@/lib/users'

describe('user form rules', () => {
  const valid = { ...emptyUserDraft(), full_name: 'Nina Patel', email: 'nina@bank.com' }

  it('accepts a complete new person', () => {
    expect(userDraftProblem(valid, true)).toBeNull()
  })

  it('needs a name, a valid email for new people, and a role', () => {
    expect(userDraftProblem({ ...valid, full_name: ' ' }, true)).toMatch(/name/)
    expect(userDraftProblem({ ...valid, email: 'nina' }, true)).toMatch(/email/)
    expect(userDraftProblem({ ...valid, email: '' }, false)).toBeNull() // email cannot be changed when editing
    expect(userDraftProblem({ ...valid, roles: [] }, true)).toMatch(/at least one role/)
  })

  it('an approver needs at least one department', () => {
    expect(userDraftProblem({ ...valid, roles: ['approver'] }, true)).toMatch(/department/)
    expect(userDraftProblem({ ...valid, roles: ['approver'], scope_department_ids: ['d1'] }, true)).toBeNull()
  })

  it('toggle adds and removes', () => {
    expect(toggle(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggle(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('builds a sign-in message with the link, email and temporary password', () => {
    const m = signInMessage('Nina Patel', 'nina@bank.com', '1a2b-3c4d-5e6f-7a8b', 'https://act.example')
    expect(m).toContain('Hi Nina,')
    expect(m).toContain('https://act.example')
    expect(m).toContain('nina@bank.com')
    expect(m).toContain('1a2b-3c4d-5e6f-7a8b')
  })

  it('describes account state', () => {
    expect(userState({ is_active: true, must_change_password: false })).toBe('active')
    expect(userState({ is_active: true, must_change_password: true })).toBe('waiting')
    expect(userState({ is_active: false, must_change_password: true })).toBe('deactivated')
  })
})
