// Task 3.2: words for platform connections on screen.
import type { PlatformJob } from '@/lib/types'

export const PLATFORM_KIND_LABEL: Record<string, string> = {
  appian_simulator: 'Appian agent-platform simulator',
}

export type JobTone = 'none' | 'running' | 'ok' | 'failed'

/** What the latest "Test connection" says. A job still open after two minutes is shown as failed (the database agrees). */
export function jobState(job: PlatformJob | null, now = Date.now()): { tone: JobTone; text: string } {
  if (!job) return { tone: 'none', text: 'Not tested yet' }
  if (!job.finished_at) {
    if (now - Date.parse(job.created_at) > 2 * 60_000) return { tone: 'failed', text: 'No answer from our site within 2 minutes' }
    return { tone: 'running', text: job.claimed_at ? 'Talking to the platform…' : 'Starting…' }
  }
  return { tone: job.ok ? 'ok' : 'failed', text: job.message ?? (job.ok ? 'Connected' : 'Failed') }
}
