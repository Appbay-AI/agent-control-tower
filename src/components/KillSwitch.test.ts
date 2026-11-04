// Task 4.3: how a step that failed and waits to be tried again reads on the agent page.
import { describe, expect, it } from 'vitest'
import { retryNote, stepState } from './KillSwitch'

describe('enforcement steps (task 4.3)', () => {
  it('a pending step that has been tried already is shown as retrying', () => {
    expect(stepState({ status: 'pending', attempts: 0 })).toBe('pending')
    expect(stepState({ status: 'pending', attempts: 2 })).toBe('retrying')
    expect(stepState({ status: 'failed', attempts: 1 })).toBe('failed')
    expect(stepState({ status: 'cancelled', attempts: 1 })).toBe('cancelled')
  })

  it('says which try failed and when the next one is', () => {
    const now = Date.parse('2026-11-04T10:00:00Z')
    expect(retryNote({ attempts: 2, next_attempt_at: '2026-11-04T10:02:00Z' }, now)).toMatch(/^Try 2 failed\. Next try at \d{1,2}:\d{2}( [AP]M)?\.$/)
    expect(retryNote({ attempts: 1, next_attempt_at: '2026-11-04T09:59:00Z' }, now)).toBe('Try 1 failed. Next try any moment now.')
  })
})
