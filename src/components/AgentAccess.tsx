// Task 4.8: on an agent's page, everyone who can use it (owners in Control Tower, owner and sharing on its platform),
// with their role and whether that role may see the agent's data (the data-authority matrix on the Users page).
import { Check, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { DATA_LABEL } from '@/lib/format'
import { useAsync } from '@/lib/useAsync'

export function AgentAccess({ agentId, refreshKey }: { agentId: string; refreshKey?: string }) {
  const { data } = useAsync(() => api.agentAccess(agentId), [agentId, refreshKey])
  if (!data || data.length === 0) return null
  const bad = data.filter((p) => p.missing.length > 0).length
  return (
    <section className="bg-card space-y-2 rounded-lg border p-4" data-testid="agent-access">
      <div>
        <h2 className="font-semibold">People with access</h2>
        <p className="text-muted-foreground text-xs">
          {bad === 0 ? 'Everyone here has authority for this agent\'s data.' : `${bad} without authority for this agent's data (Data authority, on the Users page).`}
        </p>
      </div>
      <ul className="divide-y text-sm">
        {data.map((p) => (
          <li key={p.email} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5" data-testid="access-person" data-ok={p.missing.length === 0}>
            <span>
              <span className="font-medium">{p.name ?? p.email}</span>
              <span className="text-muted-foreground"> · {p.job_title ?? 'role not known'} · {p.how.join(', ')}</span>
            </span>
            {p.missing.length === 0
              ? <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><Check className="size-3.5" /> Authorised</span>
              : <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-400" data-testid="access-missing">
                  <ShieldAlert className="size-3.5" /> Not authorised for {p.missing.map((k) => DATA_LABEL[k]).join(', ')}
                </span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
