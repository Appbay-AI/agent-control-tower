import { describe, expect, it } from 'vitest'
import { ctText, mismatchCsv, rolesText, type MismatchRow } from '@/lib/piiMismatch'

describe('access mismatch report wording (task 6.7)', () => {
  it('names roles, Control Tower standing and kinds in plain words', () => {
    expect(rolesText(['*'])).toBe('Everyone')
    expect(rolesText(['Customer Service Agent', 'Risk Analyst'])).toBe('Customer Service Agent, Risk Analyst')
    expect(rolesText([])).toBe('No role is authorised')
    expect(ctText({ ct_user: false, active: null, ct_roles: [] })).toBe('Not a Control Tower user')
    expect(ctText({ ct_user: true, active: false, ct_roles: ['owner'] })).toMatch(/\(deactivated\)$/)
  })
  it('exports the rows as CSV', () => {
    const r = { name: 'Ana Costa', email: 'ana@bank.test', role: 'Sales Associate', ct_user: false, active: null, ct_roles: [], agent: 'AGT-0003 Sales Lead Summariser',
      department: 'Retail Lending', how: ['Shared on Northbridge'], missing: ['personal'], authorised_roles: [], since: '2026-11-15T10:00:00Z' } as unknown as MismatchRow
    expect(mismatchCsv([r]).split('\r\n')[1]).toBe('Ana Costa,ana@bank.test,Sales Associate,Not a Control Tower user,AGT-0003 Sales Lead Summariser,Retail Lending,Shared on Northbridge,Personal data,No role is authorised,15 Nov 2026')
  })
})
