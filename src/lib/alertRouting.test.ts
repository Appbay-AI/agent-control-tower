import { describe, expect, it } from 'vitest'
import { describeEvents, describeRecipients, describeTarget, emptyRoute, orderRoutes, routeProblem } from './alertRouting'
import type { AlertRoute } from './types'

const names = { agents: new Map([['a1', 'AGT-0002 Invoice Matcher']]), departments: new Map([['d1', 'Payments']]) }
const route = (over: Partial<AlertRoute>): AlertRoute => ({ ...emptyRoute(), id: 'x', name: 'R', updated_at: '', ...over }) as AlertRoute

describe('alert routing (task 5.2)', () => {
  it('lists routes in the order they are checked: agent, department, default', () => {
    const r = orderRoutes([route({ id: 'def', scope: 'default' }), route({ id: 'dep', department_id: 'd1' }), route({ id: 'ag', scope: 'agent', agent_id: 'a1' })], names)
    expect(r.map((x) => x.id)).toEqual(['ag', 'dep', 'def'])
  })
  it('says in plain words what a route covers and who it sends to', () => {
    expect(describeTarget({ scope: 'department', department_id: 'd1', agent_id: null }, names)).toBe('Department: Payments')
    expect(describeEvents([])).toBe('All alerts')
    expect(describeEvents(['suspended', 'reactivated'])).toBe('Suspended, Switched back on')
    expect(describeRecipients(route({ to_business_owner: false, people: ['p1'], also_default: true }), new Map([['p1', 'Daniel Okafor']])))
      .toBe('Daniel Okafor, plus everyone on the default route')
    expect(describeRecipients(route({ scope: 'default', to_admins: true, to_business_owner: true, also_default: false }), new Map())).toBe('Every admin, the business owner')
  })
  it('will not save a route that sends to nobody or has no target', () => {
    expect(routeProblem({ ...emptyRoute(), name: 'X' })).toBe('Choose the department.')
    expect(routeProblem({ ...emptyRoute(), name: 'X', department_id: 'd1', to_business_owner: false })).toBe('Choose at least one person to send to.')
    expect(routeProblem({ ...emptyRoute(), name: 'X', department_id: 'd1' })).toBeNull()
  })
})
