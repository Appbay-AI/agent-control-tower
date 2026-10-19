import { ArrowLeft, ArrowUpRight, CheckCircle2, Clock, XCircle } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { RiskBadge, StatusBadge } from '@/components/badges'
import { RequestDecisionPanel } from '@/components/RequestDecisionPanel'
import { RequestStatusBadge, UrgencyBadge } from '@/components/requestBadges'
import { ErrorBox, Field, LoadingRows, TagList } from '@/components/ui-bits'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { AUTONOMY, DATA_LABEL, formatDateTime, formatMoney } from '@/lib/format'
import { detailEntries, headline, humanAction, requestAmount, requestPermissions } from '@/lib/requests'
import { useAsync } from '@/lib/useAsync'

/** Task 2.4: one action an agent asked to take. What it wants and why; approve, reject with a reason, or escalate. */
export function RequestPage() {
  const { id } = useParams()
  const { session, roles, scopeDepartmentIds } = useAuth()
  const userId = session!.user.id
  const navigate = useNavigate()

  const { data, error, loading, reload } = useAsync(async () => {
    const request = await api.actionRequest(id!)
    const [agent, departments, profiles] = await Promise.all([api.agent(request.agent_id), api.departments(), api.allProfiles()])
    const perms = requestPermissions({ request, agent, userId, roles, scopeDepartmentIds })
    const targets = perms.canDecide ? await api.escalationTargets(request.id) : []
    return {
      request, agent, perms, targets,
      department: departments.find((d) => d.id === agent.department_id)?.name ?? null,
      people: new Map(profiles.map((p) => [p.id, p.full_name])),
    }
  }, [id, roles.join(), scopeDepartmentIds.join()])

  const back = (
    <Link to="/approvals" className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline">
      <ArrowLeft className="size-4" /> Approvals
    </Link>
  )
  if (error) return <div className="space-y-4"><ErrorBox message={error} />{back}</div>
  if (loading && !data) return <LoadingRows rows={8} />
  if (!data) return null

  const { request: r, agent: a, perms, targets, department, people } = data
  const name = (uid: string | null) => (uid ? people.get(uid) ?? 'Former user' : null)
  const amount = requestAmount(r)
  const details = detailEntries(r.details)

  return (
    <div className="space-y-6">
      {back}

      {/* What the agent wants */}
      <div className="space-y-2">
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
          <span>{r.request_code}</span>
          <RequestStatusBadge status={r.status} />
          {r.urgency !== 'normal' && <UrgencyBadge urgency={r.urgency} />}
          <span>· asked {formatDateTime(r.requested_at)}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="request-headline">{headline(r, a.name)}</h1>
        {amount && <div className="text-3xl font-semibold tabular-nums">{amount}</div>}
      </div>

      <section className="bg-card space-y-2 rounded-lg border p-4">
        <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Because</h2>
        <p className="text-base whitespace-pre-line">{r.reasoning?.trim() || <span className="text-muted-foreground">The agent gave no reason.</span>}</p>
      </section>

      {/* The outcome, or the decision to make */}
      {r.status === 'pending' ? (
        <Alert className="border-brand-yellow bg-brand-yellow/10">
          <Clock />
          <AlertTitle>Why it needs a person</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{r.hold_reason ?? r.decision_reason}</p>
            <p className="text-sm">
              {r.assigned_to
                ? <>Assigned to <strong>{name(r.assigned_to)}</strong>. </>
                : <>Any {department ?? ''} approver may decide. </>}
              {r.routing_note && <span className="text-muted-foreground">{r.routing_note}.</span>}
            </p>
            {perms.canDecide
              ? <RequestDecisionPanel requestId={r.id} agentLive={a.status === 'live'} targets={targets} onDone={(what) => what === 'escalate'
                  // Once handed over, it may no longer be visible to this person: go back to the list.
                  ? navigate('/approvals', { state: { notice: `${r.request_code} was escalated.` } })
                  : reload()} />
              : perms.whyNot && <p className="font-medium">{perms.whyNot}</p>}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant={r.status === 'approved' ? 'default' : 'destructive'}
          className={r.status === 'approved' ? 'border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40' : undefined}>
          {r.status === 'approved' ? <CheckCircle2 className="text-emerald-700" /> : <XCircle />}
          <AlertTitle>{r.status === 'approved' ? 'Approved' : r.status === 'rejected' ? 'Rejected' : 'Not allowed'}{r.decided_at && ` on ${formatDateTime(r.decided_at)}`}</AlertTitle>
          <AlertDescription className="space-y-1">
            <p data-testid="request-outcome">{r.decision_reason}</p>
            {r.decision_source === 'policy' && <p className="text-sm">Decided automatically by the agent's autonomy rules.</p>}
            {r.status === 'approved' && a.status !== 'live' && (
              <p className="text-sm font-medium">{a.agent_code} is now {a.status}, so it has been told not to proceed.</p>
            )}
            {r.hold_reason && r.decision_source === 'human' && <p className="text-muted-foreground text-sm">It waited because: {r.hold_reason}</p>}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section className="space-y-3">
          <h2 className="font-medium">The request</h2>
          <dl className="grid grid-cols-2 gap-4">
            <Field label="Action">{humanAction(r.action)} <span className="text-muted-foreground text-xs">({r.action})</span></Field>
            <Field label="Amount">{amount}</Field>
            <Field label="System">{r.target_system}</Field>
            <Field label="How many">{r.volume}</Field>
            {details.map(([k, v]) => <Field key={k} label={k}>{v}</Field>)}
            {r.escalated_at && (
              <div className="col-span-2">
                <Field label="Escalated">
                  {formatDateTime(r.escalated_at)} by {name(r.escalated_by)}: {r.escalation_reason}
                </Field>
              </div>
            )}
          </dl>
        </section>

        <section className="space-y-3">
          <h2 className="flex items-center justify-between font-medium">
            The agent
            <Link to={`/agents/${a.id}`} className="text-muted-foreground inline-flex items-center gap-1 text-sm font-normal hover:underline">
              Open <ArrowUpRight className="size-3.5" />
            </Link>
          </h2>
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-medium">{a.name}</span>
            <span className="text-muted-foreground">{a.agent_code}</span>
            <StatusBadge status={a.status} />
            <RiskBadge tier={a.risk_tier} />
          </div>
          <p className="text-sm">{a.purpose_statement}</p>
          <dl className="grid grid-cols-2 gap-4">
            <Field label="Department">{department}</Field>
            <Field label="Business owner">{name(a.business_owner_id) ?? <span className="text-red-700">None</span>}</Field>
            <Field label="Autonomy when asked">
              Level {r.autonomy_level} · {AUTONOMY[r.autonomy_level].name}
              {r.value_threshold != null && ` · up to ${formatMoney(r.value_threshold, r.threshold_currency ?? 'GBP')}`}
            </Field>
            <Field label="Data it touches"><TagList items={a.data_classifications.map((d) => DATA_LABEL[d])} /></Field>
          </dl>
        </section>
      </div>
    </div>
  )
}
