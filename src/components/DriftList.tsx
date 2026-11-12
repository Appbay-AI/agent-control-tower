// Task 4.9: drift records. Every change made outside Control Tower that a platform shows (switched back on, blocked,
// owner, sharing, tools and data changed), with what was expected, what was seen, who did it, what Control Tower did
// and the result. On an agent's page (its own) and on the Incidents page (all the agents the user can see).
import { GitCompareArrows } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import type { Agent, DriftEvent, DriftKind } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'

export const DRIFT_LABEL: Record<DriftKind, string> = {
  switched_on_outside: 'Switched back on outside Control Tower',
  blocked_outside: 'Blocked on its platform',
  owner_changed: 'Owner changed on its platform',
  sharing_changed: 'Sharing changed on its platform',
  capabilities_changed: 'Tools or data changed on its platform',
}

/** A result that still needs a person (or is still being worked on) is shown in red. */
export function driftNeedsAttention(d: Pick<DriftEvent, 'result'>): boolean {
  return /^(Not blocked|Without authority|Blocking again)/.test(d.result)
}

export function DriftList({ agentId, refreshKey, agents, limit }: { agentId?: string; refreshKey?: string; agents?: Map<string, Agent>; limit?: number }) {
  const { data } = useAsync(() => api.driftEvents(agentId), [agentId, refreshKey])
  if (!data || data.length === 0) return null
  const rows = limit ? data.slice(0, limit) : data
  return (
    <section className="bg-card space-y-2 rounded-lg border p-4" data-testid="drift-list">
      <div>
        <h2 className="flex items-center gap-2 font-semibold"><GitCompareArrows className="size-4" /> Drift</h2>
        <p className="text-muted-foreground text-xs">Changes made outside Control Tower that {agentId ? 'its platform' : 'the platforms'} showed, and what was done about each.</p>
      </div>
      <ul className="divide-y text-sm">
        {rows.map((d) => {
          const a = agents?.get(d.agent_id)
          return (
            <li key={d.id} className="space-y-1 py-2" data-testid="drift-event" data-kind={d.kind}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium">
                  {!agentId && <><Link to={`/agents/${d.agent_id}`} className="hover:underline">{a ? `${a.agent_code} ${a.name}` : 'An agent'}</Link> · </>}
                  {DRIFT_LABEL[d.kind]}
                </span>
                <span className="text-muted-foreground text-xs">{formatDateTime(d.detected_at)}</span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">Expected</dt><dd className="break-words">{d.expected}</dd>
                <dt className="text-muted-foreground">Seen</dt><dd className="break-words">{d.observed}</dd>
                <dt className="text-muted-foreground">Who</dt><dd className="break-words">{d.actor}</dd>
                <dt className="text-muted-foreground">Done</dt><dd className="break-words">{d.action}</dd>
                <dt className="text-muted-foreground">Result</dt>
                <dd className={driftNeedsAttention(d) ? 'font-medium break-words text-red-700 dark:text-red-400' : 'break-words'} data-testid="drift-result">{d.result}</dd>
              </dl>
              {d.incident_id && <Link to={`/incidents/${d.incident_id}`} className="text-xs hover:underline">Open the incident</Link>}
            </li>
          )
        })}
      </ul>
      {limit && data.length > limit && <p className="text-muted-foreground text-xs">Showing the latest {limit} of {data.length}.</p>}
    </section>
  )
}
