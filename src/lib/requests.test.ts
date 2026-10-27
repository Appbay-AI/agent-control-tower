import { detailEntries, headline, humanAction, requestAmount, requestPermissions } from '@/lib/requests'
import type { AppRole } from '@/lib/types'

describe('how a request reads to the approver', () => {
  it('turns action codes into words', () => {
    expect(humanAction('payment.release')).toBe('Payment release')
    expect(humanAction('fx_deal-book')).toBe('Fx deal book')
    expect(humanAction('')).toBe('Act')
  })

  it('says what the agent wants in one sentence, using its own description when given', () => {
    expect(headline({ action: 'payment.release', description: 'Release £2m to supplier Acme Steel.' }, 'FX Payment Router'))
      .toBe('FX Payment Router wants to release £2m to supplier Acme Steel')
    expect(headline({ action: 'payment.release', description: null }, 'Payment Release Assistant'))
      .toBe('Payment Release Assistant asks for: Payment release')
    expect(headline({ action: 'x', description: 'FX conversion of USD 5m' }, 'FX Payment Router'))
      .toBe('FX Payment Router wants to FX conversion of USD 5m')
  })

  it('formats the amount in its own currency', () => {
    expect(requestAmount({ amount: 2_000_000, currency: 'GBP' })).toBe('£2,000,000')
    expect(requestAmount({ amount: null, currency: null })).toBeNull()
  })

  it('lists extra details as label and value', () => {
    expect(detailEntries({ supplier_name: 'Acme Steel', invoice: { id: 'INV-1' }, po: null }))
      .toEqual([['Supplier name', 'Acme Steel'], ['Invoice', '{"id":"INV-1"}'], ['Po', '—']])
  })
})

describe('who may decide an action request', () => {
  const agent = { business_owner_id: 'owner', technical_owner_id: 'tech', created_by: 'owner', department_id: 'payments' }
  const can = (userId: string, roles: AppRole[], assigned_to: string | null, scopes: string[] = ['payments'], status = 'pending' as const) =>
    requestPermissions({ request: { status, assigned_to }, agent, userId, roles, scopeDepartmentIds: scopes })

  it('the assigned approver decides, and nobody else does', () => {
    expect(can('ravi', ['approver'], 'ravi').canDecide).toBe(true)
    expect(can('daniel', ['approver'], 'ravi')).toEqual({ canDecide: false, whyNot: 'It is assigned to someone else.' })
    expect(can('admin', ['admin'], 'ravi').canDecide).toBe(false)
  })

  it('unassigned requests go to any approver for the department', () => {
    expect(can('daniel', ['approver'], null).canDecide).toBe(true)
    expect(can('sara', ['approver'], null, ['lending']).canDecide).toBe(false)
  })

  it('never the agent\'s owners, and nothing once decided', () => {
    expect(can('tech', ['approver', 'owner'], null).whyNot).toMatch(/own or created/)
    expect(requestPermissions({ request: { status: 'approved', assigned_to: 'ravi' }, agent, userId: 'ravi', roles: ['approver'], scopeDepartmentIds: [] }))
      .toEqual({ canDecide: false, whyNot: null })
  })

  it('four-eyes: whoever approved first cannot also give the second approval (task 2.10)', () => {
    const r = { status: 'pending' as const, assigned_to: null }
    expect(requestPermissions({ request: r, agent, userId: 'ravi', roles: ['approver'], scopeDepartmentIds: ['payments'], approvedBy: ['ravi'] }))
      .toEqual({ canDecide: false, whyNot: 'You have approved it. A second approver must decide.' })
    expect(requestPermissions({ request: r, agent, userId: 'daniel', roles: ['approver'], scopeDepartmentIds: ['payments'], approvedBy: ['ravi'] }).canDecide).toBe(true)
  })
})
