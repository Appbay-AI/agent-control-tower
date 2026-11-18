// Task 6.7 (R5.4): the personal-data access mismatch report. Everyone who can use an agent that handles data their
// role (job title) is not authorised for: who, their role and Control Tower roles, how they have access, which agent,
// what they lack authority for, and which roles may see it. From the data-authority check (task 4.8), which runs again
// whenever owners, sharing, job titles, data kinds or the matrix change. Done when: mismatches are listed with roles.
import { CheckCircle2, Download, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBox, LoadingRows, PageHeader } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { day, when } from '@/lib/format'
import { ctText, kindsText, mismatchCsv, rolesText } from '@/lib/piiMismatch'
import { useAsync } from '@/lib/useAsync'

export function DataAccessPage() {
  const [personalOnly, setPersonalOnly] = useState(true)
  const { data, error, loading, reload } = useAsync(() => api.piiMismatches(personalOnly), [personalOnly])

  function download() {
    if (!data) return
    const url = URL.createObjectURL(new Blob([mismatchCsv(data.rows)], { type: 'text/csv;charset=utf-8' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `data-access-mismatches-${data.at.slice(0, 10)}.csv` })
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  return (
    <div className="space-y-6" data-testid="data-access">
      <PageHeader title="Data access mismatches"
        subtitle="People who can use an agent that handles data their role is not authorised for, as of the latest check. Fix one by changing the sharing on the platform, the person's job title, or which roles may see the data (Users page)."
        actions={<Button variant="outline" onClick={reload} disabled={loading}><RefreshCw /> Refresh</Button>} />
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Which data">
        <Button size="sm" variant={personalOnly ? 'default' : 'outline'} aria-pressed={personalOnly} onClick={() => setPersonalOnly(true)}>Personal data</Button>
        <Button size="sm" variant={!personalOnly ? 'default' : 'outline'} aria-pressed={!personalOnly} onClick={() => setPersonalOnly(false)}>All sensitive data</Button>
        {data && data.rows.length > 0 && <Button size="sm" variant="ghost" onClick={download}><Download /> CSV ({data.rows.length})</Button>}
      </div>
      {error && <ErrorBox message={error} />}
      {loading && !data && <LoadingRows rows={5} />}
      {data && (
        <>
          <section className="grid grid-cols-3 gap-3" aria-label="Mismatch summary">
            {([['Mismatches', data.total, 'mm-total'], ['People', data.people, 'mm-people'], ['Agents', data.agents, 'mm-agents']] as const).map(([label, n, id]) => (
              <div key={id} className="bg-card rounded-lg border p-3">
                <div className={`text-2xl font-semibold ${n ? 'text-red-700 dark:text-red-400' : ''}`} data-testid={id}>{n}</div>
                <div className="text-sm font-medium">{label}</div>
              </div>
            ))}
          </section>

          {data.total === 0 ? (
            <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400" data-testid="mm-none">
              <CheckCircle2 className="size-4" aria-hidden /> Everyone who can use an agent is authorised for its {data.personal_only ? 'personal data' : 'data'}.
            </p>
          ) : (
            <>
              <section className="bg-card rounded-lg border p-4" aria-label="By role">
                <h2 className="font-semibold">By role</h2>
                <p className="text-muted-foreground mb-2 text-xs">The roles (job titles) with access they should not have.</p>
                <table className="w-full max-w-xl text-sm tabular-nums" data-testid="mm-roles">
                  <thead><tr className="text-muted-foreground text-left text-xs"><th className="py-1 font-medium">Role</th><th className="py-1 text-right font-medium">Mismatches</th><th className="py-1 text-right font-medium">People</th></tr></thead>
                  <tbody>{data.by_role.map((r) => (
                    <tr key={r.role} className="border-t"><td className="py-1">{r.role || 'No job title'}</td><td className="text-right">{r.mismatches}</td><td className="text-right">{r.people}</td></tr>
                  ))}</tbody>
                </table>
              </section>

              <section className="bg-card rounded-lg border p-4" aria-label="Every mismatch">
                <h2 className="font-semibold">Every mismatch</h2>
                <p className="text-muted-foreground mb-2 text-xs">Newest first. As of {when(data.at)} UTC.</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[60rem] text-sm" data-testid="mm-table">
                    <thead>
                      <tr className="text-muted-foreground text-left text-xs">
                        <th className="py-1 pr-3 font-medium">Person</th><th className="py-1 pr-3 font-medium">Role (job title)</th><th className="py-1 pr-3 font-medium">Agent</th>
                        <th className="py-1 pr-3 font-medium">How they have access</th><th className="py-1 pr-3 font-medium">Lacks authority for</th>
                        <th className="py-1 pr-3 font-medium">Roles that may see it</th><th className="py-1 font-medium">Since</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((r) => (
                        <tr key={`${r.agent_id}-${r.email}`} className="border-t align-top" data-testid="mm-row">
                          <td className="py-1.5 pr-3"><div className="font-medium">{r.name ?? r.email}</div><div className="text-muted-foreground text-xs">{r.email}</div>
                            <div className="text-muted-foreground text-xs" data-testid="mm-ct">{ctText(r)}</div></td>
                          <td className="py-1.5 pr-3" data-testid="mm-role">{r.role ?? <span className="text-muted-foreground">No job title</span>}</td>
                          <td className="py-1.5 pr-3"><Link to={`/agents/${r.agent_id}`} className="font-medium hover:underline">{r.agent}</Link>
                            <div className="text-muted-foreground text-xs">{r.department ?? 'No department'} · handles {kindsText(r.data)}</div></td>
                          <td className="py-1.5 pr-3">{r.how.join(', ')}</td>
                          <td className="py-1.5 pr-3 font-medium text-red-700 dark:text-red-400">{kindsText(r.missing)}</td>
                          <td className="py-1.5 pr-3" data-testid="mm-authorised">{rolesText(r.authorised_roles)}</td>
                          <td className="py-1.5 whitespace-nowrap">{day(r.since)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  )
}
