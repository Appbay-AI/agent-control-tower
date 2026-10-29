import { describe, expect, it } from 'vitest'
import { jobState } from './platforms'
import type { PlatformJob } from './types'

const NOW = Date.parse('2026-10-29T10:00:00Z')
const job = (over: Partial<PlatformJob>): PlatformJob => ({
  id: 1, connection_id: 'c', kind: 'check', created_at: new Date(NOW - 5_000).toISOString(), claimed_at: null, finished_at: null,
  ok: null, message: null, result: null, ...over,
})

describe('platform connection status (task 3.2)', () => {
  it('says what the latest test found', () => {
    expect(jobState(null, NOW)).toEqual({ tone: 'none', text: 'Not tested yet' })
    expect(jobState(job({}), NOW)).toEqual({ tone: 'running', text: 'Starting…' })
    expect(jobState(job({ claimed_at: new Date(NOW).toISOString() }), NOW)).toEqual({ tone: 'running', text: 'Talking to the platform…' })
    expect(jobState(job({ finished_at: new Date(NOW).toISOString(), ok: true, message: 'Connected: 8 agents found' }), NOW))
      .toEqual({ tone: 'ok', text: 'Connected: 8 agents found' })
    expect(jobState(job({ finished_at: new Date(NOW).toISOString(), ok: false, message: 'Refused the API key' }), NOW))
      .toEqual({ tone: 'failed', text: 'Refused the API key' })
    expect(jobState(job({ created_at: new Date(NOW - 3 * 60_000).toISOString() }), NOW))
      .toEqual({ tone: 'failed', text: 'No answer from our site within 2 minutes' })
  })
})
