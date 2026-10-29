// Task 3.3: on the Agent registry page, the agents found on connected platforms by the last sync. Seen by those who
// see the whole registry (admins, executives, auditors). Making a found agent a governed registry entry is task 3.5.
import { Link } from 'react-router-dom'
import { WarningBadge } from '@/components/badges'
import { ErrorBox, LoadingRows } from '@/components/ui-bits'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import type { PlatformAgentRow } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'
import { cn } from '@/lib/utils'

const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap'

function PlatformStatus({ status }: { status: PlatformAgentRow['status'] }) {
  return status === 'blocked'
    ? <span className={cn(pill, 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200')}>Blocked on platform</span>
    : <span className={cn(pill, 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200')}>Active on platform</span>
}

export function PlatformAgents({ query, agentCodes }: { query: string; agentCodes: Map<string, string> }) {
  const { hasRole } = useAuth()
  const allowed = hasRole('admin', 'executive', 'auditor')
  const { data, error, loading } = useAsync(async () => {
    if (!allowed) return null
    const [agents, connections] = await Promise.all([api.platformAgents(), api.platformConnections().catch(() => [])])
    return { agents, platform: new Map(connections.map((c) => [c.id, c.name])) }
  }, [allowed])
  if (!allowed) return null

  const q = query.trim().toLowerCase()
  const rows = (data?.agents ?? []).filter((a) => !q || [a.name, a.external_id, a.owner_email, a.owner_name, a.department]
    .some((v) => v?.toLowerCase().includes(q)))
  const missing = rows.filter((a) => a.missing_since).length
  const unregistered = rows.filter((a) => !a.agent_id && !a.missing_since).length

  return (
    <section className="space-y-2" data-testid="platform-agents">
      <div>
        <h2 className="font-semibold">Found on agent platforms</h2>
        <p className="text-muted-foreground text-sm">
          {data ? `${rows.length} listed by connected platforms · ${unregistered} not yet governed here${missing ? ` · ${missing} missing at source` : ''}. `
            : ''}Updated by each sync (see Integrations).
        </p>
      </div>
      <ErrorBox message={error} />
      {loading && !data && <LoadingRows rows={2} />}
      {data && rows.length === 0 && (
        <div className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
          {data.agents.length === 0 ? 'Nothing synced yet.' : 'No platform agents match this search.'}
        </div>
      )}
      {rows.length > 0 && (
        <ul className="bg-card divide-y rounded-lg border text-sm">
          {rows.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 p-3" data-testid="platform-agent">
              <div className="min-w-0">
                <div className="font-medium">{a.name}</div>
                <div className="text-muted-foreground text-xs">
                  {a.external_id} · {data?.platform.get(a.connection_id) ?? 'Platform'}{a.environment ? ` · ${a.environment}` : ''}
                </div>
                <div className="text-xs">
                  {a.owner_email ? <>{a.owner_name ?? a.owner_email}<span className="text-muted-foreground"> · {a.department ?? 'No department'}</span></>
                    : <><WarningBadge>No owner</WarningBadge><span className="text-muted-foreground"> {a.department ?? ''}</span></>}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 text-xs">
                <div className="flex flex-wrap justify-end gap-1">
                  <PlatformStatus status={a.status} />
                  {a.missing_since && <WarningBadge>Missing at source</WarningBadge>}
                </div>
                <span className="text-muted-foreground">
                  {a.missing_since ? `Not listed since ${formatDateTime(a.missing_since)}` : `Last seen ${formatDateTime(a.last_seen_at)}`}
                </span>
                {a.agent_id
                  ? <Link to={`/agents/${a.agent_id}`} className="hover:underline">Registered as {agentCodes.get(a.agent_id) ?? 'an agent'}</Link>
                  : <span className="text-muted-foreground">Not yet governed in Control Tower</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
