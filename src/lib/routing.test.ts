import { describe, expect, it } from 'vitest'
import { describeConditions, emptyRule, reorder, ruleProblem, secondApproval, type SecondApprovalContext } from '@/lib/routing'

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

describe('second approval (task 5.6)', () => {
  const ctx: SecondApprovalContext = {
    agents: new Map([
      ['crit', { agent_code: 'AGT-0001', risk_tier: 'critical', department_id: 'pay', owners: ['tom', null] }],
      ['low', { agent_code: 'AGT-0002', risk_tier: 'low', department_id: 'pay', owners: [] }],
    ]),
    departments: new Map([['pay', 'Payments'], ['ops', 'Operations']]),
    people: new Map([['ravi', 'Ravi Menon'], ['daniel', 'Daniel Okafor'], ['tom', 'Tom Becker'], ['omar', 'Omar Farouk']]),
    scopes: new Map([['pay', ['ravi', 'daniel', 'tom']], ['ops', ['omar']]]),
  }
  const rule = { agent_id: null, department_id: null, min_risk_tier: null, approver_id: 'ravi' }

  it('names the other approvers for the rule\'s department, not the rule\'s approver', () => {
    const s = secondApproval({ ...rule, department_id: 'pay' }, ctx)
    expect(s).toMatchObject({ when: 'critical', nobody: false })
    expect(s.text).toBe("For a Critical agent: any other approver for Payments: Daniel Okafor, Tom Becker (not the agent's owners).")
  })
  it('for one agent, leaves out its owners', () => {
    expect(secondApproval({ ...rule, agent_id: 'crit' }, ctx).text).toBe('For a Critical agent: any other approver for Payments: Daniel Okafor.')
  })
  it('says when it is always needed, never needed, or nobody can give it', () => {
    expect(secondApproval({ ...rule, department_id: 'pay', min_risk_tier: 'critical' }, ctx).text).toMatch(/^any other approver for Payments/)
    expect(secondApproval({ ...rule, agent_id: 'low' }, ctx)).toMatchObject({ when: 'never', nobody: false })
    expect(secondApproval({ ...rule, approver_id: 'omar', department_id: 'ops' }, ctx)).toMatchObject({ nobody: true })
    expect(secondApproval(rule, ctx).text).toBe("For a Critical agent: any other approver for the agent's department (not its owners).")
  })
})
