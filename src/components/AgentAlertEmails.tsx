// Task 5.1: on an agent's page, the alert emails sent about it (suspended, switched back on, blocked again, not
// stopped yet, found, missing from its platform, access without authority): who was told and whether it went out.
import { Mail } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { useAsync } from '@/lib/useAsync'

export const ALERT_EVENT_LABEL: Record<string, string> = {
  suspended: 'Suspended',
  reactivated: 'Switched back on',
  re_quarantined: 'Blocked again (switched on outside Control Tower)',
  enforcement_pending: 'Not stopped everywhere yet',
  discovered: 'Found on its platform, not registered',
  missing_at_source: 'Missing from its platform',
  access_without_authority: 'Access without authority',
}

/** Emails about the same event, grouped: one line per event with everyone told. */
export function groupAlertEmails(rows: { event: string; headline: string; person: string; status: string; at: string }[]) {
  const out: { key: string; event: string; headline: string; at: string; people: { person: string; status: string }[] }[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (last && last.headline === r.headline && last.event === r.event && Math.abs(Date.parse(last.at) - Date.parse(r.at)) < 60_000) {
      last.people.push({ person: r.person, status: r.status })
    } else out.push({ key: `${r.event}|${r.at}|${out.length}`, event: r.event, headline: r.headline, at: r.at, people: [{ person: r.person, status: r.status }] })
  }
  return out
}

export function AgentAlertEmails({ agentId, refreshKey }: { agentId: string; refreshKey?: string }) {
  const { data } = useAsync(() => api.agentAlertEmails(agentId), [agentId, refreshKey])
  const [all, setAll] = useState(false)
  if (!data || data.length === 0) return null
  const groups = groupAlertEmails(data)
  const shown = all ? groups : groups.slice(0, 5)
  return (
    <section className="bg-card space-y-2 rounded-lg border p-4" data-testid="agent-alert-emails">
      <div>
        <h2 className="flex items-center gap-2 font-semibold"><Mail className="size-4" /> Alert emails</h2>
        <p className="text-muted-foreground text-xs">Emailed to every admin and the agent's business owner, with its owners, everyone who can use it and the data it touches.</p>
      </div>
      <ul className="divide-y text-sm">
        {shown.map((g) => (
          <li key={g.key} className="space-y-0.5 py-2" data-testid="alert-email" data-event={g.event}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-medium">{ALERT_EVENT_LABEL[g.event] ?? g.event}</span>
              <span className="text-muted-foreground text-xs">{formatDateTime(g.at)}</span>
            </div>
            <p className="text-muted-foreground text-xs">{g.headline}</p>
            <p className="text-xs">{g.people.map((p) => `${p.person}: ${p.status}`).join(' · ')}</p>
          </li>
        ))}
      </ul>
      {groups.length > 5 && (
        <button type="button" className="text-xs hover:underline" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${groups.length}`}</button>
      )}
    </section>
  )
}
