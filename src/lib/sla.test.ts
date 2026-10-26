import { describeOverdue, ruleProblem, emptyRule } from '@/lib/routing'
import { dueState, durationText, shortSpan } from '@/lib/sla'

describe('time limits in plain words (task 2.9)', () => {
  it('says a limit like the database does', () => {
    expect([1, 30, 60, 90, 120, 1440, 2880].map(durationText)).toEqual(['1 minute', '30 minutes', '1 hour', '90 minutes', '2 hours', '1 day', '2 days'])
  })

  it('says how long is left, or how late it is', () => {
    const now = Date.UTC(2026, 9, 27, 10, 0)
    expect(dueState(null, now)).toBeNull()
    expect(dueState(new Date(now + 25 * 60000).toISOString(), now)).toEqual({ text: 'Decide within 25 min', tone: 'ok' })
    expect(dueState(new Date(now + 10 * 60000).toISOString(), now)).toEqual({ text: 'Decide within 10 min', tone: 'soon' })
    expect(dueState(new Date(now + 125 * 60000).toISOString(), now)?.text).toBe('Decide within 2 h 5 min')
    expect(dueState(new Date(now - 3 * 60000).toISOString(), now)).toEqual({ text: 'Overdue by 3 min: being handled automatically', tone: 'overdue' })
    expect(shortSpan(3 * 86400000)).toBe('3 days')
    expect(shortSpan(20000)).toBe('1 min')
  })

  it('describes what a rule does when nobody decides in time', () => {
    const people = new Map([['daniel', 'Daniel Okafor']])
    expect(describeOverdue({ sla_minutes: 45, on_overdue: 'escalate', overdue_escalate_to: 'daniel' }, people))
      .toBe('Within 45 minutes, else escalated once to Daniel Okafor')
    expect(describeOverdue({ sla_minutes: null, on_overdue: 'reject', overdue_escalate_to: null }, people))
      .toBe('Within the default time for its urgency, else it expires and the agent is told no')
  })

  it('checks the time-limit fields before saving', () => {
    const base = { ...emptyRule(10), name: 'Large payments', approver_id: 'ravi' }
    expect(ruleProblem(base)).toBeNull()
    expect(ruleProblem({ ...base, sla_minutes: 0 })).toMatch(/whole number of minutes/)
    expect(ruleProblem({ ...base, sla_minutes: 1.5 })).toMatch(/whole number of minutes/)
    expect(ruleProblem({ ...base, on_overdue: 'escalate' })).toBe('Choose who it goes to when nobody decides in time.')
    expect(ruleProblem({ ...base, on_overdue: 'escalate', overdue_escalate_to: 'ravi' })).toBe("Escalate to someone other than the rule's approver.")
    expect(ruleProblem({ ...base, sla_minutes: 30, on_overdue: 'escalate', overdue_escalate_to: 'daniel' })).toBeNull()
  })
})
