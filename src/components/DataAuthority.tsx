// Task 4.8: the data-authority matrix (which roles may see which data) on the Users page, and the people who can use
// an agent without authority for its data. Admins tick and untick; every agent is checked again at once.
import { ShieldAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBox, LoadingRows } from '@/components/ui-bits'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { DATA_LABEL, errorMessage, formatDateTime } from '@/lib/format'
import type { DataAuthorityRow, DataClassification } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'

export const KINDS: DataClassification[] = ['public', 'internal', 'confidential', 'restricted', 'personal']

/** Rows of the matrix: "Everyone" first, then every known job title, A to Z. */
export function matrixRows(rows: DataAuthorityRow[], titles: string[]): { title: string; allowed: Set<DataClassification> }[] {
  const by = new Map<string, Set<DataClassification>>()
  for (const t of ['*', ...titles]) by.set(t, by.get(t) ?? new Set())
  for (const r of rows) by.set(r.job_title, (by.get(r.job_title) ?? new Set()).add(r.classification))
  return [...by.entries()].sort(([a], [b]) => (a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b))).map(([title, allowed]) => ({ title, allowed }))
}

export function DataAuthority() {
  const { hasRole } = useAuth()
  const admin = hasRole('admin')
  const { data, error, loading, reload } = useAsync(async () => {
    const [rows, titles, findings, agents] = await Promise.all([api.dataAuthority(), api.knownJobTitles(), api.authorityFindings(), api.agents()])
    return { rows, titles, findings, agents: new Map(agents.map((a) => [a.id, a])) }
  })
  const [busy, setBusy] = useState<string | null>(null)
  // The tick changes as soon as it is clicked; it is put back if saving fails.
  const [shown, setShown] = useState<Record<string, boolean>>({})
  const [err, setErr] = useState<string | null>(null)
  const matrix = useMemo(() => (data ? matrixRows(data.rows, data.titles.map((t) => t.job_title)) : []), [data])
  const people = useMemo(() => new Map((data?.titles ?? []).map((t) => [t.job_title, t.people])), [data])

  async function toggle(title: string, kind: DataClassification, allowed: boolean) {
    const key = `${title}|${kind}`
    setBusy(key); setErr(null); setShown((s) => ({ ...s, [key]: allowed }))
    try { await api.setDataAuthority(title, kind, allowed); await reload() } catch (e) { setErr(errorMessage(e)) } finally {
      setBusy(null); setShown((s) => { const { [key]: _gone, ...rest } = s; return rest })
    }
  }

  return (
    <section className="space-y-3" data-testid="data-authority">
      <div>
        <h2 className="text-lg font-semibold">Data authority</h2>
        <p className="text-muted-foreground text-sm">
          Which roles may see which kinds of data. Everyone who can use an agent (its owners in Control Tower, its owner and the people it
          is shared with on its platform) is checked against this; someone whose role is not ticked for the agent's data raises an alert.
          {admin ? ' Changes apply at once.' : ' Only admins can change it.'}
        </p>
      </div>
      <ErrorBox message={error ?? err} />
      {loading && !data && <LoadingRows rows={4} />}

      {data && data.findings.length > 0 && (
        <div className="rounded-lg border border-red-300 p-3 dark:border-red-900" data-testid="authority-findings">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-800 dark:text-red-300">
            <ShieldAlert className="size-4" /> {data.findings.length === 1 ? '1 person uses an agent' : `${data.findings.length} people use agents`} without authority for its data
          </h3>
          <ul className="space-y-1 text-sm">
            {data.findings.map((f) => {
              const a = data.agents.get(f.agent_id)
              return (
                <li key={`${f.agent_id}|${f.email}`} data-testid="authority-finding">
                  <span className="font-medium">{f.name ?? f.email}</span> ({f.job_title ?? 'role not known'}) ·{' '}
                  <Link to={`/agents/${f.agent_id}`} className="hover:underline">{a ? `${a.agent_code} ${a.name}` : 'an agent'}</Link> ·{' '}
                  not authorised for {f.missing.map((k) => DATA_LABEL[k]).join(', ')} · {f.how.join(', ')}
                  <span className="text-muted-foreground text-xs"> · since {formatDateTime(f.first_seen_at)}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {data && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm" data-testid="authority-matrix">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-2 font-medium">Role (job title)</th>
                {KINDS.map((k) => <th key={k} className="p-2 text-center font-medium">{DATA_LABEL[k]}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y">
              {matrix.map((m) => (
                <tr key={m.title} data-testid="authority-row" data-title={m.title}>
                  <td className="p-2">
                    {m.title === '*' ? <span className="font-medium">Everyone</span> : m.title}
                    {m.title !== '*' && people.get(m.title) ? <span className="text-muted-foreground text-xs"> · {people.get(m.title)} {people.get(m.title) === 1 ? 'person' : 'people'}</span> : null}
                  </td>
                  {KINDS.map((k) => {
                    const on = shown[`${m.title}|${k}`] ?? m.allowed.has(k)
                    const viaEveryone = m.title !== '*' && matrix[0].allowed.has(k)
                    return (
                      <td key={k} className="p-2 text-center">
                        <input type="checkbox" className="size-4 align-middle" checked={on || viaEveryone}
                          disabled={!admin || viaEveryone || busy !== null}
                          aria-label={`${m.title === '*' ? 'Everyone' : m.title} may see ${DATA_LABEL[k]}`}
                          title={viaEveryone ? 'Allowed for everyone' : undefined}
                          onChange={(e) => toggle(m.title, k, e.target.checked)} />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
