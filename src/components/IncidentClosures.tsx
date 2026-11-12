// Task 4.9: on the Approvals page, resolved incidents the user was named to approve closing.
import { CheckCircle2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { RiskBadge } from '@/components/badges'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import { useAsync } from '@/lib/useAsync'

export function IncidentClosures() {
  const { session } = useAuth()
  const me = session!.user.id
  const { data } = useAsync(async () => {
    const list = await api.incidentsToClose(me)
    if (list.length === 0) return []
    const [agents, profiles] = await Promise.all([api.agents(), api.allProfiles()])
    const byId = new Map(agents.map((a) => [a.id, a]))
    const people = new Map(profiles.map((p) => [p.id, p.full_name]))
    return list.map((i) => ({ i, a: byId.get(i.agent_id), asker: i.closure_requested_by ? people.get(i.closure_requested_by) ?? 'Former user' : 'Someone' }))
  }, [me])
  if (!data || data.length === 0) return null
  return (
    <section className="space-y-2" data-testid="incident-closures">
      <h2 className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-4" /> Incidents to close ({data.length})</h2>
      <ul className="divide-y rounded-lg border">
        {data.map(({ i, a, asker }) => (
          <li key={i.id} className="space-y-1 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/incidents/${i.id}`} className="font-medium hover:underline">{i.incident_code} {i.title}</Link>
              <RiskBadge tier={i.severity} />
            </div>
            <p>{asker} asks you to approve closing it{a ? ` (${a.agent_code} ${a.name})` : ''}{i.closure_note ? `: “${i.closure_note}”` : '.'}</p>
            <p className="text-muted-foreground text-xs">Asked {i.closure_requested_at && formatDateTime(i.closure_requested_at)} · open the incident to approve or turn down</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
