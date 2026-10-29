import { describe, expect, it } from 'vitest'
import { jobState, nextSyncText, syncChoices, syncEveryText } from './platforms'
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

describe('platform sync wording (task 3.3)', () => {
  const at = (iso: string) => Date.parse(iso)
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

  it('says how often, and offers an unusual stored value too', () => {
    expect(syncEveryText(30)).toBe('Synced every 30 minutes')
    expect(syncEveryText(60)).toBe('Synced every 1 hour')
    expect(syncEveryText(null)).toBe('Automatic sync off')
    expect(syncChoices(30)).not.toContain(45)
    expect(syncChoices(45)).toContain(45)
    expect(jobState(null, NOW, 'Not synced yet').text).toBe('Not synced yet')
  })

  it('says when the next automatic sync starts (the clock ticks every 5 minutes)', () => {
    // Last sync 10:00:20, every 30 minutes: due after 10:29:20, so the 10:30 tick.
    expect(nextSyncText(30, '2026-10-29T10:00:20Z', at('2026-10-29T10:12:00Z'))).toBe(`Next automatic sync at ${hhmm('2026-10-29T10:30:00Z')}`)
    // Overdue or never synced: the next tick.
    expect(nextSyncText(30, '2026-10-29T08:00:00Z', at('2026-10-29T10:12:00Z'))).toBe(`Next automatic sync at ${hhmm('2026-10-29T10:15:00Z')}`)
    expect(nextSyncText(30, null, at('2026-10-29T10:12:00Z'))).toBe(`Next automatic sync at ${hhmm('2026-10-29T10:15:00Z')}`)
    expect(nextSyncText(null, null)).toBeNull()
  })
})
