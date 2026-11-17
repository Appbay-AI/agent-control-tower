import { describe, expect, it } from 'vitest'
import { retirementSteps, stepLine } from './RetirementSteps'
import type { AgentEnforcement } from '@/lib/types'

const e = (over: Partial<AgentEnforcement>): AgentEnforcement => ({
  id: 1, agent_id: 'a', suspension_id: null, method: 'platform', action: 'stop', cause: 'retirement', reactivation_id: null,
  target: 'Northbridge Agent Platform (simulated) as NAP-006', status: 'pending', detail: null, attempts: 0,
  next_attempt_at: '2026-11-17T10:05:00Z', claimed_at: null, created_at: '2026-11-17T10:00:00Z', finished_at: null, ...over,
} as AgentEnforcement)

describe('retirement steps on the agent page (task 5.5)', () => {
  it('says where it stands: blocking, blocked and read back, trying again, needing a person', () => {
    expect(stepLine(e({})).text).toBe('Blocking on Northbridge Agent Platform (simulated) as NAP-006…')
    expect(stepLine(e({ status: 'done' }))).toEqual({ state: 'done', text: 'Blocked on Northbridge Agent Platform (simulated) as NAP-006; read back as blocked' })
    expect(stepLine(e({ attempts: 1, detail: 'Appian did not answer' }), Date.parse('2026-11-17T10:01:00Z')).text)
      .toMatch(/^Not blocked on .* yet: Appian did not answer\. Try 1 failed\. Next try at /)
    expect(stepLine(e({ status: 'failed', detail: 'No such agent' })).state).toBe('failed')
  })
  it('shows the retirement\'s steps and any stop still under way, not old finished suspension steps', () => {
    const list = [e({ id: 1, cause: 'suspension', status: 'done' }), e({ id: 2, cause: 'suspension', status: 'pending' }), e({ id: 3 }), e({ id: 4, method: 'api', status: 'done' })]
    expect(retirementSteps(list).map((x) => x.id)).toEqual([2, 3])
  })
})
