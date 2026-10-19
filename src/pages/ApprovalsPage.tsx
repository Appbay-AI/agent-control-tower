import { CheckCircle2, ChevronRight } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { RiskBadge } from '@/components/badges'
import { DecisionPanel } from '@/components/DecisionPanel'
import { UrgencyBadge } from '@/components/requestBadges'
import { ErrorBox, LoadingRows, PageHeader, TagList } from '@/components/ui-bits'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { AUTONOMY, DATA_LABEL, formatDateTime, formatMoney } from '@/lib/format'
import { agentPermissions } from '@/lib/permissions'
import { headline, requestAmount, requestPermissions } from '@/lib/requests'
import { useAsync } from '@/lib/useAsync'

export function ApprovalsPage() {
  const { session, roles, scopeDepartmentIds } = useAuth()
  const userId = session!.user.id
  const notice = (useLocation().state as { notice?: string } | null)?.notice

  const { data, error, loading, reload } = useAsync(async () => {
    const [pending, agents, decisions, departments, profiles, waiting] = await Promise.all([
      api.pendingRegistrations(), api.agents(), api.decisions(), api.departments(), api.allProfiles(), api.actionRequests('pending'),
    ])
    const byId = new Map(agents.map((a) => [a.id, a]))
    // Action requests (task 2.4): oldest first, so nothing waits longest unseen.
    const requests = waiting
      .map((req) => ({ req, agent: byId.get(req.agent_id)! }))
      .filter((x) => x.agent)
      .map((x) => ({ ...x, perms: requestPermissions({ request: x.req, agent: x.agent, userId, roles, scopeDepartmentIds }) }))
      .reverse()
    const items = pending
      .map((reg) => ({ reg, agent: byId.get(reg.agent_id)! }))
      .filter((x) => x.agent)
      .map((x) => ({ ...x, perms: agentPermissions({ agent: x.agent, userId, roles, scopeDepartmentIds, pending: x.reg, decisions }) }))
    return {
      myRequests: requests.filter((x) => x.perms.canDecide),
      otherRequests: requests.filter((x) => !x.perms.canDecide),
      mine: items.filter((x) => x.perms.canDecide),
      others: items.filter((x) => !x.perms.canDecide),
      dept: new Map(departments.map((d) => [d.id, d.name])),
      people: new Map(profiles.map((p) => [p.id, p.full_name])),
    }
  }, [roles.join(), scopeDepartmentIds.join()])

  return (
    <div className="space-y-5">
      <PageHeader title="Approvals" subtitle="Actions agents want to take, and new agents waiting to go live" />
      {notice && <p className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-2 text-sm dark:bg-emerald-950/40">{notice}</p>}
      <ErrorBox message={error} />
      {loading && !data && <LoadingRows />}

      {data && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Agent actions</h2>
          {data.myRequests.length === 0 ? (
            <div className="text-muted-foreground flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm">
              <CheckCircle2 className="size-5 text-emerald-600" aria-hidden /> No agent action is waiting for your decision.
            </div>
          ) : (
            <ul className="space-y-3">
              {data.myRequests.map(({ req, agent: a }) => (
                <li key={req.id}>
                  <Link to={`/approvals/requests/${req.id}`} data-testid="request-card"
                    className="bg-card hover:border-foreground/30 flex items-center gap-3 rounded-lg border p-4">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
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
