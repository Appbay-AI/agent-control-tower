// Tasks 3.2 and 3.3: words for platform connections on screen.
import { durationText } from '@/lib/sla'
import type { PlatformJob } from '@/lib/types'

export const PLATFORM_KIND_LABEL: Record<string, string> = {
  appian_simulator: 'Appian agent-platform simulator',
}

export type JobTone = 'none' | 'running' | 'ok' | 'failed'

/** What the latest "Test connection" says. A job still open after two minutes is shown as failed (the database agrees). */
export function jobState(job: PlatformJob | null, now = Date.now(), never = 'Not tested yet'): { tone: JobTone; text: string } {
  if (!job) return { tone: 'none', text: never }
  if (!job.finished_at) {
    if (now - Date.parse(job.created_at) > 2 * 60_000) return { tone: 'failed', text: 'No answer from our site within 2 minutes' }
    return { tone: 'running', text: job.claimed_at ? 'Talking to the platform…' : 'Starting…' }
  }
  return { tone: job.ok ? 'ok' : 'failed', text: job.message ?? (job.ok ? 'Connected' : 'Failed') }
}

// Task 3.3: how often each platform is synced.

const SYNC_CHOICES = [5, 15, 30, 60, 120, 240, 720, 1440]

/** The choices offered, keeping an unusual stored value so it is not lost. */
export function syncChoices(current: number | null): number[] {
  return current === null || SYNC_CHOICES.includes(current) ? SYNC_CHOICES : [...SYNC_CHOICES, current].sort((a, b) => a - b)
}

export function syncEveryText(minutes: number | null): string {
  return minutes === null ? 'Automatic sync off' : `Synced every ${durationText(minutes)}`
}

/**
 * When the next automatic sync starts. The database clock runs at :00, :05, :10… and starts a sync once its interval
 * (less a minute's grace) has passed since the last one.
 */
export function nextSyncText(minutes: number | null, lastSyncStarted: string | null, now = Date.now()): string | null {
  if (minutes === null) return null
  const TICK = 5 * 60_000
  const due = lastSyncStarted ? Date.parse(lastSyncStarted) + (minutes - 1) * 60_000 : now
  const at = Math.ceil(Math.max(due, now + 1) / TICK) * TICK
  return `Next automatic sync at ${new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}
