// Task 5.5: on a retired agent's page, the steps that block it on its platform (Appian), as the kill switch shows its
// own: blocking, blocked and read back, trying again, or needing a person.
import { Archive } from 'lucide-react'
import { retryNote, stepState } from '@/components/KillSwitch'
import { formatDateTime } from '@/lib/format'
import type { AgentEnforcement } from '@/lib/types'

/** The platform steps that still matter once an agent is retired: the retirement's own, and any stop still under way. */
export function retirementSteps(all: AgentEnforcement[]): AgentEnforcement[] {
  return all.filter((e) => e.method === 'platform' && e.action === 'stop' && (e.cause === 'retirement' || e.status === 'pending' || e.status === 'failed'))
}

export function stepLine(e: AgentEnforcement, now = Date.now()): { state: string; text: string } {
  const s = stepState(e)
  if (s === 'done') return { state: 'done', text: `Blocked on ${e.target}; read back as blocked` }
  if (s === 'failed') return { state: 'failed', text: `Not blocked on ${e.target}: ${e.detail ?? 'failed'}. A person needs to act.` }
  if (s === 'retrying') return { state: 'retrying', text: `Not blocked on ${e.target} yet: ${e.detail ?? 'no answer'}. ${retryNote(e, now)}` }
  if (s === 'cancelled') return { state: 'cancelled', text: `${e.target}: ${e.detail ?? 'stopped trying'}` }
  return { state: 'pending', text: `Blocking on ${e.target}…` }
}

export function RetirementSteps({ enforcements }: { enforcements: AgentEnforcement[] }) {
  const steps = retirementSteps(enforcements)
  if (steps.length === 0) return null
  return (
    <section className="bg-card space-y-2 rounded-lg border p-4 text-sm" data-testid="retire-steps">
      <h2 className="flex items-center gap-2 font-semibold"><Archive className="size-4" /> Retired: blocked on its platform</h2>
      <ul className="space-y-1">
        {steps.map((e) => {
          const l = stepLine(e)
          return (
            <li key={e.id} data-testid="retire-step" data-state={l.state}
              className={l.state === 'failed' || l.state === 'retrying' ? 'font-medium text-red-700 dark:text-red-400' : l.state === 'done' ? 'text-emerald-700 dark:text-emerald-400' : ''}>
              {l.text}
              {e.finished_at && l.state === 'done' && <span className="text-muted-foreground text-xs"> · {formatDateTime(e.finished_at)}</span>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
