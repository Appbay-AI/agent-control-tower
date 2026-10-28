// Task 2.11: check-ins (heard from) and the silent-agent limit, said in plain words.
import { durationText, shortSpan } from '@/lib/sla'
import type { AgentContact, LogLevel } from '@/lib/types'

/** "Just now", "12 min ago", "6 h 12 min ago", "3 days ago", or "Never". */
export function heardAgo(lastSeenAt: string | null | undefined, now = Date.now()): string {
  if (!lastSeenAt) return 'Never'
  const ms = now - new Date(lastSeenAt).getTime()
  if (ms < 60_000) return 'Just now'
  return `${shortSpan(ms)} ago`
}

/** The limits offered on the agent's page. A value set some other way is offered too. */
export const SILENCE_CHOICES = [1, 5, 15, 30, 60, 120, 240, 720, 1440]

export function silenceChoices(current: number | null): number[] {
  return current === null || SILENCE_CHOICES.includes(current) ? SILENCE_CHOICES : [...SILENCE_CHOICES, current].sort((a, b) => a - b)
}

export function silenceLimitText(minutes: number | null): string {
  return minutes === null ? 'Not watched' : `Flag if silent for more than ${durationText(minutes)}`
}

export type WatchState = { text: string; tone: 'ok' | 'late' | 'off' }

/** What the watch says now: next check-in due, or how long it has been quiet. */
export function watchState(limit: number | null, contact: AgentContact | null, live: boolean, now = Date.now()): WatchState {
  if (limit === null) return { text: 'Not watched for silence', tone: 'off' }
  if (!live) return { text: 'Watched only while Live', tone: 'off' }
  const times = [contact?.last_seen_at, contact?.watch_from].filter((t): t is string => !!t).map((t) => new Date(t).getTime())
  const from = times.length ? Math.max(...times) : now
  const due = from + limit * 60_000
  return due > now
    ? { text: `Next check-in due within ${shortSpan(due - now)}`, tone: 'ok' }
    : { text: `Silent: nothing heard for more than ${durationText(limit)}`, tone: 'late' }
}

export const LEVEL_LABEL: Record<LogLevel, string> = { debug: 'Debug', info: 'Info', warning: 'Warning', error: 'Error' }
export const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: 'bg-muted text-muted-foreground',
  info: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  warning: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  error: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
}
