import { describe, expect, it } from 'vitest'
import { heatStep } from '@/lib/risk'

describe('risk dashboard heat map (task 6.4)', () => {
  it('shades by share of the largest cell, empty cells blank', () => {
    expect([0, 1, 2, 7, 14].map((n) => heatStep(n, 14))).toEqual([0, 1, 1, 4, 7])
    expect(heatStep(1, 1)).toBe(7)
    expect(heatStep(3, 0)).toBe(0)
  })
})
