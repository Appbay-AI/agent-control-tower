// Task 4.8: the matrix's rows.
import { describe, expect, it } from 'vitest'
import { matrixRows } from './DataAuthority'

describe('data-authority matrix rows (task 4.8)', () => {
  it('Everyone first, then every known job title A to Z, with what each may see', () => {
    const rows = matrixRows([{ job_title: '*', classification: 'public' }, { job_title: 'KYC Officer', classification: 'personal' }],
      ['Sales Associate', 'KYC Officer'])
    expect(rows.map((r) => r.title)).toEqual(['*', 'KYC Officer', 'Sales Associate'])
    expect([...rows[1].allowed]).toEqual(['personal'])
    expect(rows[2].allowed.size).toBe(0)
  })
})
