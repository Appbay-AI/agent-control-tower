import { describe, expect, it } from 'vitest'
import { heardAgo, silenceChoices, silenceLimitText, watchState } from './checkins'
import type { AgentContact } from './types'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const contact = (lastMin: number | null, watchMin: number | null): AgentContact => ({
  agent_id: 'a', last_seen_at: lastMin === null ? null : ago(lastMin), last_seen_via: 'check-in', last_note: null,
  watch_from: watchMin === null ? null : ago(watchMin),
})

describe('check-ins (task 2.11)', () => {
  it('says how long ago the agent was heard from', () => {
    expect(heardAgo(null, NOW)).toBe('Never')
    expect(heardAgo(ago(0.5), NOW)).toBe('Just now')
    expect(heardAgo(ago(12), NOW)).toBe('12 min ago')
    expect(heardAgo(ago(372), NOW)).toBe('6 h 12 min ago')
  })

  it('words the limit and keeps an unusual value in the choices', () => {
    expect(silenceLimitText(null)).toBe('Not watched')
    expect(silenceLimitText(60)).toBe('Flag if silent for more than 1 hour')
    expect(silenceChoices(60)).not.toContain(45)
    expect(silenceChoices(45)).toContain(45)
  })

  it('shows when the next check-in is due, or that the agent is silent', () => {
    expect(watchState(null, contact(5, 100), true, NOW)).toEqual({ text: 'Not watched for silence', tone: 'off' })
    expect(watchState(60, contact(5, 100), false, NOW)).toEqual({ text: 'Watched only while Live', tone: 'off' })
    expect(watchState(60, contact(5, 100), true, NOW)).toEqual({ text: 'Next check-in due within 55 min', tone: 'ok' })
    expect(watchState(60, contact(372, 1000), true, NOW)).toEqual({ text: 'Silent: nothing heard for more than 1 hour', tone: 'late' })
    // Never heard from: counted from when watching started.
    expect(watchState(15, contact(null, 10), true, NOW)).toEqual({ text: 'Next check-in due within 5 min', tone: 'ok' })
  })
})
