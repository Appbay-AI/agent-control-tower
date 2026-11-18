import { describe, expect, it } from 'vitest'
import { dueText, waitingCount } from '@/lib/myWork'

describe('my work wording (task 6.5)', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  it('says how overdue or how soon, for times and for review dates', () => {
    expect(dueText('2026-11-18T09:50:00Z', now)).toBe('Overdue by 2 h 10 min')
    expect(dueText('2026-11-18T12:45:00Z', now)).toBe('Due in 45 min')
    expect(dueText('2026-11-13', now)).toBe('Overdue by 5 days')
    expect(dueText('2026-11-18', now)).toBe('Due today')
    expect(dueText(null, now)).toBe('No deadline')
  })
  it('counts everything waiting for me', () => {
    expect(waitingCount({ requests: [{} as never, {} as never], registrations: [{} as never], reactivations: [], closures: [{} as never] })).toBe(4)
  })
})
