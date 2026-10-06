import { Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { RiskBadge, StatusBadge, WarningBadge } from '@/components/badges'
import { ErrorBox, LoadingRows, PageHeader, selectClass } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { AUTONOMY, formatDate, isReviewOverdue, RISK_LABEL, STATUS_LABEL } from '@/lib/format'
import type { AgentStatus, RiskTier } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'

export function AgentsPage() {
  const { hasRole } = useAuth()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<AgentStatus | ''>('')
  const [risk, setRisk] = useState<RiskTier | ''>('')
  const [flag, setFlag] = useState<'' | 'no_owner' | 'overdue' | 'pending'>('')

  const { data, error, loading } = useAsync(async () => {
    const [agents, departments, profiles, pending] = await Promise.all([
      api.agents(), api.departments(), api.profiles(), api.pendingRegistrations(),
    ])
    return {
      agents,
      dept: new Map(departments.map((d) => [d.id, d.name])),
      people: new Map(profiles.map((p) => [p.id, p.full_name])),
      pending: new Set(pending.map((r) => r.agent_id)),
    }
  })

  const rows = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return data.agents.filter((a) => {
      if (status && a.status !== status) return false
      if (risk && a.risk_tier !== risk) return false
      if (flag === 'no_owner' && a.business_owner_id) return false
      if (flag === 'overdue' && !isReviewOverdue(a.next_review_date, a.status)) return false
      if (flag === 'pending' && !data.pending.has(a.id)) return false
      if (!q) return true
      return [a.name, a.agent_code, a.vendor_name, data.dept.get(a.department_id ?? ''), data.people.get(a.business_owner_id ?? '')]
        .some((v) => v?.toLowerCase().includes(q))
    })
  }, [data, query, status, risk, flag])

  const counts = useMemo(() => {
    const agents = data?.agents ?? []
    return {
      total: agents.filter((a) => a.status !== 'retired').length,
      noOwner: agents.filter((a) => !a.business_owner_id && a.status !== 'retired').length,
      overdue: agents.filter((a) => isReviewOverdue(a.next_review_date, a.status)).length,
      pending: data?.pending.size ?? 0,
    }
  }, [data])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agent registry"
        subtitle={data ? `${counts.total} active agents` : 'Every AI agent, its owner, purpose and limits'}
        actions={hasRole('owner', 'admin') && (
          <Button asChild><Link to="/agents/new"><Plus /> Register agent</Link></Button>
        )}
      />

      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Active agents" value={counts.total} onClick={() => setFlag('')} active={flag === ''} />
          <Stat label="No owner" value={counts.noOwner} tone={counts.noOwner ? 'bad' : undefined}
            onClick={() => setFlag('no_owner')} active={flag === 'no_owner'} />
          <Stat label="Review overdue" value={counts.overdue} tone={counts.overdue ? 'warn' : undefined}
            onClick={() => setFlag('overdue')} active={flag === 'overdue'} />
          <Stat label="Waiting for approval" value={counts.pending} onClick={() => setFlag('pending')} active={flag === 'pending'} />
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" aria-hidden />
          <Input placeholder="Search name, code, owner, department, vendor" className="pl-8" value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="Search agents" />
        </div>
        <select className={`${selectClass} sm:w-40`} value={status} onChange={(e) => setStatus(e.target.value as AgentStatus | '')}
          aria-label="Filter by status">
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className={`${selectClass} sm:w-36`} value={risk} onChange={(e) => setRisk(e.target.value as RiskTier | '')}
          aria-label="Filter by risk">
          <option value="">All risk tiers</option>
          {Object.entries(RISK_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>

      <ErrorBox message={error} />
      {loading && !data && <LoadingRows />}

      {data && rows.length === 0 && (
        <div className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          {data.agents.length === 0 ? 'No agents registered yet.' : 'No agents match these filters.'}
        </div>
      )}

      {data && rows.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-lg border md:block">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-muted-foreground text-left text-xs uppercase">
                <tr>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="px-3 py-2 font-medium">Business owner</th>
                  <th className="px-3 py-2 font-medium">Department</th>
                  <th className="px-3 py-2 font-medium">Autonomy</th>
                  <th className="px-3 py-2 font-medium">Risk</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Next review</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const overdue = isReviewOverdue(a.next_review_date, a.status)
                  return (
                    <tr key={a.id} className="hover:bg-muted/40 cursor-pointer border-t" onClick={() => navigate(`/agents/${a.id}`)}>
                      <td className="px-3 py-2.5">
                        <Link to={`/agents/${a.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                          {a.name}
                        </Link>
                        <div className="text-muted-foreground text-xs">{a.agent_code}{a.vendor_name ? ` · ${a.vendor_name}` : ''}</div>
                      </td>
                      <td className="px-3 py-2.5">
                        {a.business_owner_id ? data.people.get(a.business_owner_id) ?? 'Unknown' : <WarningBadge>No owner</WarningBadge>}
                      </td>
                      <td className="px-3 py-2.5">{data.dept.get(a.department_id ?? '') ?? '—'}</td>
                      <td className="px-3 py-2.5">{a.autonomy_level} · {AUTONOMY[a.autonomy_level].name}</td>
                      <td className="px-3 py-2.5"><RiskBadge tier={a.risk_tier} /></td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          <StatusBadge status={a.status} />
                          {data.pending.has(a.id) && <span className="text-muted-foreground text-xs">awaiting approval</span>}
                        </div>
                      </td>
                      <td className={`px-3 py-2.5 ${overdue ? 'font-medium text-red-700 dark:text-red-400' : ''}`}>
                        {formatDate(a.next_review_date)}{overdue && ' · overdue'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Phone cards */}
          <ul className="space-y-2 md:hidden">
            {rows.map((a) => (
              <li key={a.id}>
                <Link to={`/agents/${a.id}`} className="bg-card block rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{a.name}</div>
                      <div className="text-muted-foreground text-xs">{a.agent_code} · {data.dept.get(a.department_id ?? '') ?? 'No department'}</div>
                    </div>
                    <StatusBadge status={a.status} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    <RiskBadge tier={a.risk_tier} />
                    <span className="text-muted-foreground">Level {a.autonomy_level}</span>
                    {!a.business_owner_id && <WarningBadge>No owner</WarningBadge>}
                    {isReviewOverdue(a.next_review_date, a.status) && <WarningBadge>Review overdue</WarningBadge>}
                    {data.pending.has(a.id) && <span className="text-muted-foreground">· awaiting approval</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, tone, onClick, active }: {
  label: string; value: number; tone?: 'bad' | 'warn'; onClick: () => void; active: boolean
}) {
  const color = tone === 'bad' ? 'text-red-700 dark:text-red-400' : tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : ''
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`bg-card rounded-lg border p-3 text-left transition hover:shadow-sm ${active ? 'ring-brand-yellow ring-2' : ''}`}>
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </button>
  )
}
