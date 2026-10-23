import { CheckCircle2, ChevronRight } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { RiskBadge } from '@/components/badges'
import { AlertsCard } from '@/components/AlertsCard'
import { DecisionPanel } from '@/components/DecisionPanel'
import { UrgencyBadge } from '@/components/requestBadges'
import { ErrorBox, LoadingRows, PageHeader, TagList } from '@/components/ui-bits'
import { cn } from '@/lib/utils'
import { AUTONOMY, DATA_LABEL, formatDateTime, formatMoney } from '@/lib/format'
import { useAuth } from '@/lib/auth'
import { FALLBACK_POLL_MS, useLive, type LiveStatus } from '@/lib/live'
import { headline, requestAmount } from '@/lib/requests'

/** Whether the list is updating on its own (task 2.5). */
function LiveIndicator({ status }: { status: LiveStatus }) {
  const text = status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…'
    : `Live updates paused · checking every ${FALLBACK_POLL_MS / 1000} seconds`
  return (
    <span data-testid="live-status" title={status === 'live' ? 'New tasks appear here on their own' : undefined}
      className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
      <span aria-hidden className={cn('size-2 rounded-full', status === 'live' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-slate-400' : 'bg-amber-500')} />
      {text}
    </span>
  )
}

function NewBadge() {
  return <span className="bg-brand-yellow text-brand-charcoal rounded px-1.5 text-[10px] leading-4 font-semibold uppercase">New</span>
}

export function ApprovalsPage() {
  const notice = (useLocation().state as { notice?: string } | null)?.notice
  const { hasRole } = useAuth()
  // Task 2.5: the list lives in LiveProvider and is read again whenever something changes.
  const { approvals: data, approvalsError: error, approvalsLoading: loading, reloadApprovals: reload, status, fresh } = useLive()

  return (
    <div className="space-y-5">
      <PageHeader title="Approvals" subtitle="Actions agents want to take, and new agents waiting to go live" />
      <LiveIndicator status={status} />
      {hasRole('approver') && <AlertsCard />}
      {notice && <p className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-2 text-sm dark:bg-emerald-950/40">{notice}</p>}
      <ErrorBox message={error} />
      {loading && !data && <LoadingRows />}

      {data && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Agent actions</h2>
          {/* Screen readers announce new tasks as they arrive. */}
          <div aria-live="polite" className="space-y-3">
          {data.myRequests.length === 0 ? (
            <div className="text-muted-foreground flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm">
              <CheckCircle2 className="size-5 text-emerald-600" aria-hidden /> No agent action is waiting for your decision.
            </div>
          ) : (
            <ul className="space-y-3">
              {data.myRequests.map(({ req, agent: a }) => (
                <li key={req.id}>
                  <Link to={`/approvals/requests/${req.id}`} data-testid="request-card"
                    className={cn('bg-card hover:border-foreground/30 flex items-center gap-3 rounded-lg border p-4 transition-colors',
                      fresh.has(req.id) && 'border-brand-yellow ring-brand-yellow/40 ring-2')}>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                        {fresh.has(req.id) && <NewBadge />}
                        <span>{req.request_code}</span>
                        <span>· {formatDateTime(req.requested_at)}</span>
                        <RiskBadge tier={a.risk_tier} />
                        {req.urgency !== 'normal' && <UrgencyBadge urgency={req.urgency} />}
                      </div>
                      <div className="font-medium">{headline(req, a.name)}</div>
                      {req.reasoning && <div className="text-muted-foreground line-clamp-2 text-sm">Because {req.reasoning}</div>}
                    </div>
                    {requestAmount(req) && <div className="text-lg font-semibold whitespace-nowrap tabular-nums">{requestAmount(req)}</div>}
                    <ChevronRight className="text-muted-foreground size-5 shrink-0" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {data.otherRequests.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-muted-foreground text-sm font-medium">Also waiting, for someone else</h3>
              <ul className="divide-y rounded-lg border text-sm">
                {data.otherRequests.map(({ req, agent: a }) => (
                  <li key={req.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <Link to={`/approvals/requests/${req.id}`} className="hover:underline">
                      {headline(req, a.name)} <span className="text-muted-foreground">· {req.request_code}</span>
                    </Link>
                    <span className="text-muted-foreground text-xs whitespace-nowrap">
                      {req.assigned_to ? `With ${data.people.get(req.assigned_to) ?? 'former user'}` : `Any ${data.dept.get(a.department_id ?? '') ?? ''} approver`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          </div>
        </section>
      )}

      {data && <h2 className="pt-2 text-lg font-semibold">New agents</h2>}
      {data && data.mine.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-sm">
          <CheckCircle2 className="size-8 text-emerald-600" aria-hidden />
          No new agent is waiting for your approval.
        </div>
      )}

      <ul className="space-y-4">
        {data?.mine.map(({ reg, agent: a, perms }) => (
          <li key={reg.id} className="bg-card space-y-4 rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <Link to={`/agents/${a.id}`} className="text-lg font-semibold hover:underline">{a.name}</Link>
                {fresh.has(reg.id) && <> <NewBadge /></>}
                <div className="text-muted-foreground text-xs">
                  {a.agent_code} · {data.dept.get(a.department_id ?? '')} · submitted {formatDateTime(reg.submitted_at)}
                  {reg.submitted_by ? ` by ${data.people.get(reg.submitted_by)}` : ' via API'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <RiskBadge tier={a.risk_tier} />
                {reg.required_approvals > 1 && (
                  <span className="text-xs font-medium">Four-eyes · {perms.approvalsSoFar} of {reg.required_approvals}</span>
                )}
              </div>
            </div>
            <p className="text-sm">{a.purpose_statement}</p>
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div><dt className="text-muted-foreground text-xs uppercase">Owner</dt><dd>{data.people.get(a.business_owner_id ?? '')}</dd></div>
              <div><dt className="text-muted-foreground text-xs uppercase">Autonomy</dt>
                <dd>Level {a.autonomy_level} · {AUTONOMY[a.autonomy_level].name}
                  {a.value_threshold !== null && ` · up to ${formatMoney(a.value_threshold, a.threshold_currency)}`}</dd></div>
              <div><dt className="text-muted-foreground text-xs uppercase">Data</dt>
                <dd><TagList items={a.data_classifications.map((d) => DATA_LABEL[d])} /></dd></div>
              <div className="sm:col-span-3"><dt className="text-muted-foreground text-xs uppercase">Systems</dt>
                <dd><TagList items={a.systems_accessed} /></dd></div>
            </dl>
            <DecisionPanel registrationId={reg.id} onDone={() => reload()} compact />
          </li>
        ))}
      </ul>

      {data && data.others.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-muted-foreground text-sm font-medium">Also waiting, for someone else</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {data.others.map(({ reg, agent: a, perms }) => (
              <li key={reg.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <Link to={`/agents/${a.id}`} className="hover:underline">{a.name} <span className="text-muted-foreground">· {a.agent_code}</span></Link>
                <span className="text-muted-foreground text-xs">
                  {perms.alreadyDecided ? 'You approved · needs a second approver' : 'Not yours to decide'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
