// Task 4.6: on the Approvals page, suspended agents waiting for someone to approve switching them back on.
import { Power } from 'lucide-react'
import { Link } from 'react-router-dom'
import { RiskBadge } from '@/components/badges'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import { useAsync } from '@/lib/useAsync'

export function ReactivationRequests() {
  const { session, roles, scopeDepartmentIds } = useAuth()
  const me = session!.user.id
  const { data } = useAsync(async () => {
    const pending = await api.pendingReactivations()
    if (pending.length === 0) return []
    const [agents, approvals, profiles] = await Promise.all([api.agents(), api.reactivationApprovals(), api.allProfiles()])
    const byId = new Map(agents.map((a) => [a.id, a]))
    const people = new Map(profiles.map((p) => [p.id, p.full_name]))
    return pending.flatMap((r) => {
      const a = byId.get(r.agent_id)
      if (!a) return []
      const mayApprove = roles.includes('admin') || (roles.includes('approver') && a.department_id !== null && scopeDepartmentIds.includes(a.department_id))
      const done = approvals.filter((x) => x.reactivation_id === r.id)
      if (!mayApprove || r.requested_by === me || done.some((x) => x.approver_id === me)) return []
      return [{ r, a, asker: people.get(r.requested_by) ?? 'Former user', done: done.length }]
    })
  }, [roles.join(), scopeDepartmentIds.join()])

  if (!data || data.length === 0) return null
  return (
    <section className="space-y-2" data-testid="reactivation-requests">
      <h2 className="flex items-center gap-2 font-semibold"><Power className="size-4" /> Switch back on ({data.length})</h2>
      <ul className="divide-y rounded-lg border">
        {data.map(({ r, a, asker, done }) => (
          <li key={r.id} className="space-y-1 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/approvals/reactivations/${r.id}`} className="font-medium hover:underline">{a.agent_code} {a.name}</Link>
              <RiskBadge tier={a.risk_tier} />
              {r.required_approvals === 2 && <span className="text-muted-foreground text-xs">needs 2 approvals · {done} so far</span>}
            </div>
            <p>{asker} asks to switch it back on: “{r.reason}”</p>
            <p className="text-muted-foreground text-xs">Asked {formatDateTime(r.requested_at)} · open it to approve or reject</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
