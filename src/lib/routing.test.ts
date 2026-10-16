import { describe, expect, it } from 'vitest'
import { describeConditions, emptyRule, reorder, ruleProblem } from '@/lib/routing'

const names = { agents: new Map([['a1', 'FX Payment Router']]), departments: new Map([['d1', 'Payments']]) }
const blank = { agent_id: null, department_id: null, min_amount: null, max_amount: null, currency: 'GBP', data_classification: null, min_risk_tier: null }

describe('routing rules on screen', () => {
  it('describes conditions in plain words', () => {
    expect(describeConditions(blank, names)).toBe('Every waiting request')
    expect(describeConditions({ ...blank, department_id: 'd1', min_amount: 1_000_000 }, names)).toMatch(/^Payments · .*1,000,000.* and above$/)
    expect(describeConditions({ ...blank, agent_id: 'a1', data_classification: 'personal', min_risk_tier: 'high' }, names))
      .toBe('Agent FX Payment Router · touches Personal data · High risk or higher')
    expect(describeConditions({ ...blank, data_classification: 'restricted' }, names)).toBe('touches Restricted data')
  })

  it('explains problems before saving', () => {
    const ok = { ...emptyRule(10), name: 'Large payments', approver_id: 'u1' }
    expect(ruleProblem(ok)).toBeNull()
    expect(ruleProblem({ ...ok, name: ' ' })).toMatch(/name/)
    expect(ruleProblem({ ...ok, approver_id: '' })).toMatch(/approves/)
    expect(ruleProblem({ ...ok, min_amount: 10, currency: '' })).toMatch(/currency/)
    expect(ruleProblem({ ...ok, min_amount: 10, max_amount: 5 })).toMatch(/larger/)
  })

  it('moves a rule and renumbers only what changed', () => {
    const rules = [{ id: 'a', priority: 10 }, { id: 'b', priority: 20 }, { id: 'c', priority: 30 }]
    expect(reorder(rules, 'c', -1)).toEqual([{ id: 'c', priority: 20 }, { id: 'b', priority: 30 }])
    expect(reorder(rules, 'a', -1)).toEqual([])
  })
})
