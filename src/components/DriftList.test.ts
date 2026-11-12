import { describe, expect, it } from 'vitest'
import { driftNeedsAttention } from './DriftList'

describe('drift records (task 4.9)', () => {
  it('a result that still needs a person stands out', () => {
    expect(driftNeedsAttention({ result: 'Not blocked again: Appian refused. A person needs to act' })).toBe(true)
    expect(driftNeedsAttention({ result: 'Blocking again…' })).toBe(true)
    expect(driftNeedsAttention({ result: 'Without authority: Ana Costa (Sales Associate). Alert raised' })).toBe(true)
    expect(driftNeedsAttention({ result: 'Blocked again and read back as blocked at 12 Nov 10:04 UTC' })).toBe(false)
    expect(driftNeedsAttention({ result: 'Everyone with access is authorised' })).toBe(false)
  })
})
