import { describe, expect, it } from 'vitest'
import { approvalTimeScale, coveragePercent, duration, waitingFor, waitingTotal, weekLabel } from '@/lib/dashboard'

describe('executive dashboard wording (task 6.3)', () => {
  it('reads durations in plain words', () => {
    expect([null, 0.4, 45, 60, 90, 1439, 1440, 3120, 2900].map(duration)).toEqual(
      ['—', 'under a minute', '45 min', '1 h', '1 h 30 min', '23 h 59 min', '1 day', '2 days 4 h', '2 days'])
  })
  it('labels weeks, waiting time, totals and coverage', () => {
    expect(weekLabel('2026-11-09')).toBe('9 Nov')
    expect(waitingFor('2026-11-17T08:00:00Z', Date.parse('2026-11-17T09:30:00Z'))).toBe('1 h 30 min')
    expect(waitingFor(null)).toBeNull()
    expect(waitingTotal({ registrations: 1, requests: 2, reactivations: 3, closures: 4, oldest: null })).toBe(10)
    expect(coveragePercent({ listed: 8, governed: 5, awaiting: 1, retired: 1, unlinked: 1 })).toBe(71)
    expect(coveragePercent({ listed: 0, governed: 0, awaiting: 0, retired: 0, unlinked: 0 })).toBeNull()
  })
})

describe('approvalTimeScale (task 7.4)', () => {
  it('uses minutes for short decisions and hours from two hours', () => {
    expect(approvalTimeScale([{ avg_minutes: 3 }, { avg_minutes: null }, { avg_minutes: 45 }])).toEqual({ unit: 'min', per: 1 })
    expect(approvalTimeScale([{ avg_minutes: 30 }, { avg_minutes: 200 }])).toEqual({ unit: 'h', per: 60 })
    expect(approvalTimeScale([])).toEqual({ unit: 'min', per: 1 })
  })
})
