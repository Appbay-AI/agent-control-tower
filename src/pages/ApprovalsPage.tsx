import { CheckCircle2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { RiskBadge } from '@/components/badges'
import { DecisionPanel } from '@/components/DecisionPanel'
import { ErrorBox, LoadingRows, PageHeader, TagList } from '@/components/ui-bits'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { AUTONOMY, DATA_LABEL, formatDateTime, formatMoney } from '@/lib/format'
import { agentPermissions } from '@/lib/permissions'
import { useAsync } from '@/lib/useAsync'

export function ApprovalsPage() {
  const { session, roles, scopeDepartmentIds } = useAuth()
  const userId = session!.user.id

  const { data, error, loading, reload } = useAsync(async () => {
    const [pending, agents, decisions, departments, profiles] = await Promise.all([
      api.pendingRegistrations(), api.agents(), api.decisions(), api.departments(), api.profiles(),
    ])
    const byId = new Map(agents.map((a) => [a.id, a]))
    const items = pending
      .map((reg) => ({ reg, agent: byId.get(reg.agent_id)! }))
      .filter((x) => x.agent)
      .map((x) => ({ ...x, perms: agentPermissions({ agent: x.agent, userId, roles, scopeDepartmentIds, pending: x.reg, decisions }) }))
    return {
      mine: items.filter((x) => x.perms.canDecide),
      others: items.filter((x) => !x.perms.canDecide),
      dept: new Map(departments.map((d) => [d.id, d.name])),
      people: new Map(profiles.map((p) => [p.id, p.full_name])),
    }
  }, [roles.join(), scopeDepartmentIds.join()])

  return (
    <div className="space-y-5">
      <PageHeader title="Approvals" subtitle="Agents waiting for you to approve them before they can go live" />
      <ErrorBox message={error} />
      {loading && !data && <LoadingRows />}

      {data && data.mine.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-sm">
          <CheckCircle2 className="size-8 text-emerald-600" aria-hidden />
          Nothing waiting for your decision.
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
