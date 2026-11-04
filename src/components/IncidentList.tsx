// Task 4.4: a list of incidents, used on the Incidents page and on an agent's page.
import { Link } from 'react-router-dom'
import { RiskBadge } from '@/components/badges'
import { formatDateTime } from '@/lib/format'
import { INCIDENT_SOURCE_LABEL, INCIDENT_STATUS_LABEL, incidentDue, isOpen } from '@/lib/incidents'
import type { Incident } from '@/lib/types'
import { cn } from '@/lib/utils'

const STATUS_STYLE = {
  open: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
  contained: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
  resolved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
  closed: 'bg-muted text-muted-foreground',
} as const

export function IncidentStatusBadge({ status }: { status: Incident['status'] }) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', STATUS_STYLE[status])}>
    {INCIDENT_STATUS_LABEL[status]}</span>
}

export function IncidentList({ incidents, agents, name, showAgent = true, now = Date.now() }: {
  incidents: Incident[]
  /** Agent code and name by id (only needed when showAgent). */
  agents?: Map<string, { agent_code: string; name: string }>
  name: (id: string | null) => string | null
  showAgent?: boolean
  now?: number
}) {
  return (
    <ul className="divide-y rounded-lg border" data-testid="incident-list">
      {incidents.map((i) => {
        const due = incidentDue(i, now)
        const agent = agents?.get(i.agent_id)
        return (
          <li key={i.id} className={cn('space-y-1 p-3', !isOpen(i) && 'opacity-75')} data-testid="incident-row" data-code={i.incident_code}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground font-mono text-xs">{i.incident_code}</span>
              <RiskBadge tier={i.severity} />
              <IncidentStatusBadge status={i.status} />
              {due && (
                <span data-testid="incident-due" className={cn('text-xs', due.overdue ? 'font-medium text-red-700 dark:text-red-400' : 'text-muted-foreground')}>
                  {due.text}
                </span>
              )}
            </div>
            <div className="font-medium break-words">{i.title}</div>
            <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {showAgent && (
                <Link to={`/agents/${i.agent_id}`} className="hover:underline">{agent ? `${agent.agent_code} ${agent.name}` : 'Agent'}</Link>
              )}
              <span data-testid="incident-owner" title={i.owner_reason ?? undefined}>Owner: <span className="text-foreground">{name(i.owner_id) ?? 'nobody'}</span></span>
              <span>Opened {formatDateTime(i.opened_at)}</span>
              <span>Resolve by {formatDateTime(i.due_at)}</span>
              <span>{INCIDENT_SOURCE_LABEL[i.source]}: {i.reporter}</span>
            </div>
            {i.description && i.description !== i.title && i.source !== 'suspension' && (
              <p className="text-sm whitespace-pre-wrap break-words">{i.description}</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
