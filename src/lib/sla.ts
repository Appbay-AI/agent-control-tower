// Task 2.9: time limits, said in plain words. Mirrors minutes_text() in the database.

export function durationText(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 day' : `${minutes / 1440} days`
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

/** A short "how long" for what's left or how late: "25 min", "2 h 5 min", "3 days". */
export function shortSpan(ms: number): string {
  const m = Math.max(1, Math.round(Math.abs(ms) / 60000))
  if (m < 60) return `${m} min`
  if (m < 1440) return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`
  const d = Math.round(m / 1440)
  return d === 1 ? '1 day' : `${d} days`
}

export type DueState = { text: string; tone: 'ok' | 'soon' | 'overdue' } | null

/** "Decide within 25 min" (or "overdue by 3 min") for a waiting request; null when it has no limit. */
export function dueState(dueAt: string | null, now = Date.now()): DueState {
  if (!dueAt) return null
  const left = new Date(dueAt).getTime() - now
  if (left <= 0) return { text: `Overdue by ${shortSpan(left)}: being handled automatically`, tone: 'overdue' }
  return { text: `Decide within ${shortSpan(left)}`, tone: left <= 15 * 60000 ? 'soon' : 'ok' }
}

export const URGENCIES = ['critical', 'high', 'normal', 'low'] as const
