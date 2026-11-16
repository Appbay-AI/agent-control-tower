// Task 5.3: the approval task for switching a suspended agent back on, one request per page. The email to approvers
// links here; the decision is made only here (or on the agent's page), signed in. Replying to an email decides nothing.
import { ArrowLeft, Power } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { RiskBadge } from '@/components/badges'
import { Reactivation } from '@/components/Reactivation'
import { ErrorBox, LoadingRows } from '@/components/ui-bits'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import { INCIDENT_STATUS_LABEL } from '@/lib/incidents'
import { agentPermissions } from '@/lib/permissions'
import { useAsync } from '@/lib/useAsync'

export function ReactivationTaskPage() {
  const { id } = useParams()
  const { session, roles, scopeDepartmentIds } = useAuth()
  const userId = session!.user.id
  const { data, error, loading, reload } = useAsync(async () => {
    const r = await api.reactivation(id!)
    const [agent, approvals, enforcements, incidents, suspensions, profiles, departments] = await Promise.all([
      api.agent(r.agent_id), api.reactivationApprovals(r.agent_id), api.enforcements(r.agent_id), api.incidents(r.agent_id),
      api.suspensions(r.agent_id), api.allProfiles(), api.departments(),
    ])
    const reactivations = await api.reactivations(r.agent_id)
    return { r, agent, approvals, enforcements, incidents, suspensions, reactivations,
      people: new Map(profiles.map((p) => [p.id, p.full_name])), department: departments.find((d) => d.id === agent.department_id)?.name ?? null }
  }, [id])

  if (error) return (
    <div className="space-y-4">
      <ErrorBox message={error} />
      <Link to="/approvals" className="inline-flex items-center gap-1 text-sm hover:underline"><ArrowLeft className="size-4" /> Approvals</Link>
    </div>
  )
  if (loading && !data) return <LoadingRows rows={6} />
  if (!data) return null
  const { r, agent: a, approvals, enforcements, incidents, suspensions, reactivations, people, department } = data
  const name = (uid: string | null) => (uid ? people.get(uid) ?? 'Former user' : null)
  const perms = agentPermissions({ agent: a, userId, roles, scopeDepartmentIds, pending: null, decisions: [] })
  const suspension = suspensions.find((s) => s.id === r.suspension_id) ?? suspensions.find((s) => s.status === 'done') ?? null
  const live = incidents.filter((i) => i.status === 'open' || i.status === 'contained')
  // Only this request on this page: an older or newer one belongs to its own task.
  const these = reactivations.filter((x) => x.id === r.id)

  return (
    <div className="space-y-4" data-testid="reactivation-task" data-status={r.status}>
      <Link to="/approvals" className="inline-flex items-center gap-1 text-sm hover:underline"><ArrowLeft className="size-4" /> Approvals</Link>
      <div>
        <p className="text-muted-foreground flex items-center gap-1.5 text-sm"><Power className="size-4" /> Switch back on?</p>
        <h1 className="text-xl font-semibold" data-testid="reactivation-headline">
          <Link to={`/agents/${a.id}`} className="hover:underline">{a.agent_code} {a.name}</Link>
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
          <RiskBadge tier={a.risk_tier} />
          {department && <span className="text-muted-foreground">{department}</span>}
          <span className="text-muted-foreground">· {a.status === 'suspended' ? 'Suspended' : a.status[0].toUpperCase() + a.status.slice(1)}</span>
        </div>
      </div>

      <section className="bg-card space-y-2 rounded-lg border p-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Asked by</dt><dd>{name(r.requested_by)}, {formatDateTime(r.requested_at)}</dd>
          <dt className="text-muted-foreground">Why it is safe</dt><dd>{r.reason}</dd>
          <dt className="text-muted-foreground">Approvals needed</dt>
          <dd>{r.required_approvals === 2 ? 'Two people (Critical agent), neither of them the person who asked' : 'One person who is not the person who asked'}</dd>
          {suspension && <><dt className="text-muted-foreground">Suspended</dt><dd>{formatDateTime(suspension.suspended_at ?? suspension.requested_at)}: {suspension.reason}</dd></>}
          <dt className="text-muted-foreground">Incidents</dt>
          <dd>{live.length === 0 ? 'None still being worked on' : live.map((i) => (
            <Link key={i.id} to={`/incidents/${i.id}`} className="mr-2 hover:underline">{i.incident_code} ({INCIDENT_STATUS_LABEL[i.status]})</Link>))}</dd>
        </dl>
      </section>

      {r.status === 'pending' ? (
        <Reactivation part="notices" agent={a} reactivations={these} approvals={approvals} enforcements={enforcements}
          incidents={incidents} canAsk={false} canApprove={perms.canApproveReactivation} userId={userId} isAdmin={roles.includes('admin')}
          onDone={reload} name={name} />
      ) : (
        <>
          <p className="bg-muted rounded-md p-3 text-sm" data-testid="reactivation-decided">
            {r.status === 'approved' && `Approved by ${approvals.filter((x) => x.reactivation_id === r.id).map((x) => name(x.approver_id)).join(' and ')} on ${formatDateTime(r.decided_at)}.`}
            {r.status === 'rejected' && `Rejected by ${name(r.decided_by)} on ${formatDateTime(r.decided_at)}: “${r.decision_reason}”.`}
            {r.status === 'withdrawn' && `Withdrawn on ${formatDateTime(r.decided_at)}.`}
          </p>
          <Reactivation part="notices" agent={a} reactivations={these} approvals={approvals} enforcements={enforcements}
            incidents={incidents} canAsk={false} canApprove={false} userId={userId} isAdmin={false} onDone={reload} name={name} />
        </>
      )}
    </div>
  )
}
