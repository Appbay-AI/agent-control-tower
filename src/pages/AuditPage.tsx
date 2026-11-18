// Task 6.8: the audit view. Search the whole audit trail (what the signed-in person may see), open any entry to see
// what changed and its hashes, and export what was found as CSV or JSON (each export is itself recorded). Done when:
// any event can be found and exported.
import { ChevronDown, ChevronRight, Download, Search } from 'lucide-react'
import { Fragment, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBox, LoadingRows, PageHeader } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { actorText, auditCsv, changedFields, entityLabel, show, type AuditEntry, type AuditFilters } from '@/lib/audit'
import { errorMessage, when } from '@/lib/format'
import { useAsync } from '@/lib/useAsync'

const SELECT = 'border-input bg-background h-9 rounded-md border px-2 text-sm'

export function AuditPage() {
  const facets = useAsync(() => api.auditFacets())
  const [draft, setDraft] = useState<AuditFilters>({})
  const [filters, setFilters] = useState<AuditFilters>({})
  const [rows, setRows] = useState<AuditEntry[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [next, setNext] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [exported, setExported] = useState<string | null>(null)

  async function load(f: AuditFilters, before: number | null) {
    setBusy(true); setError(null)
    // A new search clears the old results at once, so nothing on screen belongs to the previous search.
    if (!before) { setRows([]); setTotal(null); setNext(null) }
    try {
      const page = await api.auditSearch(f, before)
      setRows((r) => (before ? [...r, ...page.rows] : page.rows))
      setTotal(page.total); setNext(page.next_before_seq)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  useEffect(() => { void load(filters, null) }, [filters])

  function submit(e: FormEvent) {
    e.preventDefault()
    setOpen(null); setExported(null)
    setFilters({ ...draft, query: draft.query?.trim() || undefined })
  }

  async function exportAs(format: 'csv' | 'json') {
    setBusy(true); setError(null); setExported(null)
    try {
      const all = await api.auditSearch(filters, null, true)
      const body = format === 'csv' ? auditCsv(all.rows) : JSON.stringify({ exported_at: new Date().toISOString(), filters, total: all.total, entries: all.rows }, null, 2)
      const seq = await api.auditRecordExport(filters, all.rows.length, format)
      const name = `audit-trail-${new Date().toISOString().slice(0, 10)}-${all.rows.length}.${format}`
      const url = URL.createObjectURL(new Blob([body], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' }))
      const a = Object.assign(document.createElement('a'), { href: url, download: name })
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setExported(`Exported ${all.rows.length.toLocaleString('en-GB')} entries as ${name}${all.total > all.rows.length ? ` (the first ${all.rows.length.toLocaleString('en-GB')} of ${all.total.toLocaleString('en-GB')}: narrow the search for the rest)` : ''}. The export is on the record as entry #${seq}.`)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-6" data-testid="audit">
      <PageHeader title="Audit trail"
        subtitle="Every recorded change, newest first: who did what, when and why. Entries cannot be changed or deleted, and each is chained to the one before by its hash. You see the entries for the agents you can see." />

      <form onSubmit={submit} className="bg-card grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-6 lg:items-end" aria-label="Search the audit trail">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="a-q">Words</Label>
          <Input id="a-q" placeholder="Words, AGT-0001, a name, or #1234" value={draft.query ?? ''} onChange={(e) => setDraft({ ...draft, query: e.target.value })} />
        </div>
        <div className="space-y-1.5"><Label htmlFor="a-from">From</Label><Input id="a-from" type="date" value={draft.from ?? ''} onChange={(e) => setDraft({ ...draft, from: e.target.value || undefined })} /></div>
        <div className="space-y-1.5"><Label htmlFor="a-to">To (including)</Label><Input id="a-to" type="date" value={draft.to ?? ''} onChange={(e) => setDraft({ ...draft, to: e.target.value || undefined })} /></div>
        <div className="space-y-1.5">
          <Label htmlFor="a-who">Who</Label>
          <select id="a-who" className={SELECT + ' w-full'} value={draft.actorType ?? ''} onChange={(e) => setDraft({ ...draft, actorType: e.target.value || undefined })}>
            <option value="">Anyone</option><option value="user">People</option><option value="agent">Agents</option>
            <option value="integration">Integrations</option><option value="system">The system</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="a-type">Record</Label>
          <select id="a-type" className={SELECT + ' w-full'} value={draft.entity ?? ''} onChange={(e) => setDraft({ ...draft, entity: e.target.value || undefined })}>
            <option value="">Any record</option>
            {(facets.data?.entities ?? []).map((t) => [t, entityLabel(t)] as const).sort((a, b) => a[1].localeCompare(b[1])).map(([t, l]) => <option key={t} value={t}>{l}</option>)}
          </select>
        </div>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-6">
          <Button type="submit" disabled={busy}><Search /> Search</Button>
          <Button type="button" variant="ghost" onClick={() => { setDraft({}); setFilters({}); setOpen(null); setExported(null) }}>Clear</Button>
        </div>
      </form>

      <ErrorBox message={error} />
      {total != null && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm" data-testid="audit-total"><span className="font-semibold">{total.toLocaleString('en-GB')}</span> {total === 1 ? 'entry' : 'entries'} found</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy || total === 0} onClick={() => exportAs('csv')}><Download /> Export CSV</Button>
            <Button size="sm" variant="outline" disabled={busy || total === 0} onClick={() => exportAs('json')}><Download /> Export JSON</Button>
          </div>
        </div>
      )}
      {exported && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400" data-testid="audit-exported">{exported}</p>}

      {busy && rows.length === 0 && <LoadingRows rows={6} />}
      {rows.length > 0 && (
        <div className="bg-card overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[52rem] text-sm" data-testid="audit-table">
            <thead>
              <tr className="text-muted-foreground border-b text-left text-xs">
                <th className="w-8" /><th className="py-2 pr-3 font-medium">Entry</th><th className="py-2 pr-3 font-medium">When (UTC)</th>
                <th className="py-2 pr-3 font-medium">Who</th><th className="py-2 pr-3 font-medium">What</th><th className="py-2 pr-3 font-medium">Record</th><th className="py-2 pr-3 font-medium">Agent</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <Fragment key={e.seq}>
                  <tr className="hover:bg-muted/50 cursor-pointer border-t align-top" data-testid="audit-row" data-seq={e.seq}
                    onClick={() => setOpen(open === e.seq ? null : e.seq)} aria-expanded={open === e.seq}>
                    <td className="py-2 pl-2">{open === e.seq ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</td>
                    <td className="py-2 pr-3 tabular-nums">#{e.seq}</td>
                    <td className="py-2 pr-3 whitespace-nowrap tabular-nums">{when(e.at)}</td>
                    <td className="py-2 pr-3">{actorText(e)}</td>
                    <td className="py-2 pr-3">{e.summary ?? e.action}{e.reason && <div className="text-muted-foreground text-xs">Why: {e.reason}</div>}</td>
                    <td className="py-2 pr-3">{entityLabel(e.entity_type)}</td>
                    <td className="py-2 pr-3">{e.agent_id ? <Link to={`/agents/${e.agent_id}`} onClick={(x) => x.stopPropagation()} className="hover:underline">{e.agent}</Link> : '—'}</td>
                  </tr>
                  {open === e.seq && (
                    <tr className="bg-muted/30" data-testid="audit-detail">
                      <td />
                      <td colSpan={6} className="space-y-2 py-3 pr-3 text-xs">
                        <div><span className="font-medium">Action:</span> {e.action} · <span className="font-medium">Exact time:</span> {e.at}{e.entity_id && <> · <span className="font-medium">Record ID:</span> {e.entity_id}</>}</div>
                        {changedFields(e).length > 0 ? (
                          <table className="w-full max-w-3xl"><tbody>{changedFields(e).map((c) => (
                            <tr key={c.field} className="border-t"><td className="py-1 pr-3 font-medium">{c.field}</td><td className="py-1 pr-3 break-all">{show(c.from)}</td><td className="py-1 pr-3">→</td><td className="py-1 break-all">{show(c.to)}</td></tr>
                          ))}</tbody></table>
                        ) : (e.after || e.before) && <pre className="max-h-48 overflow-auto rounded border bg-white/50 p-2 whitespace-pre-wrap dark:bg-black/20">{JSON.stringify(e.after ?? e.before, null, 2)}</pre>}
                        <div className="text-muted-foreground font-mono break-all">Hash {e.hash}<br />Previous {e.prev_hash}</div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && <Button variant="outline" disabled={busy} onClick={() => load(filters, next)}>Show more</Button>}
      {total === 0 && !busy && <p className="text-muted-foreground text-sm">No entries match this search.</p>}
    </div>
  )
}
