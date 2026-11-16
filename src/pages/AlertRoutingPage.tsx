// Task 5.2: alert routing (R4.3). Admins set who gets each alert email (task 5.1) on this screen; changes apply to the
// next alert, with no deploy. Checked in order: the agent's own routes, else its department's, else the default route.
import { BellRing, FlaskConical, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBox, LoadingRows, PageHeader, selectClass } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ALERT_EVENTS, describeEvents, describeRecipients, describeTarget, emptyRoute, orderRoutes, routeProblem } from '@/lib/alertRouting'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/format'
import type { AlertEvent, AlertRoute, AlertRouteDraft, AlertRoutePreview } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'

export function AlertRoutingPage() {
  const { data, error, loading, reload } = useAsync(async () => {
    const [routes, agents, departments, people] = await Promise.all([api.alertRoutes(), api.agents(), api.departments(), api.allProfiles()])
    const names = {
      agents: new Map(agents.map((a) => [a.id, `${a.agent_code} ${a.name}`])),
      departments: new Map(departments.map((d) => [d.id, d.name])),
    }
    return { routes: orderRoutes(routes, names), agents, departments, people, names, peopleNames: new Map(people.map((p) => [p.id, p.full_name])) }
  })
  const [editing, setEditing] = useState<{ id: string | null; draft: AlertRouteDraft } | null>(null)
  const [deleting, setDeleting] = useState<AlertRoute | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    const problem = routeProblem(editing.draft)
    if (problem) { setFormError(problem); return }
    setBusy(true); setFormError(null)
    try {
      const d = editing.draft
      await api.saveAlertRoute(editing.id, {
        ...d, name: d.name.trim(),
        department_id: d.scope === 'department' ? d.department_id : null,
        agent_id: d.scope === 'agent' ? d.agent_id : null,
        events: d.scope === 'default' ? [] : d.events,
        also_default: d.scope === 'default' ? false : d.also_default,
      })
      setEditing(null); setNotice('Saved. The next alert follows it.')
      await reload()
    } catch (err) { setFormError(errorMessage(err)) } finally { setBusy(false) }
  }

  if (error) return <ErrorBox message={error} />
  if (loading && !data) return <LoadingRows />
  if (!data) return null
  const set = <K extends keyof AlertRouteDraft>(k: K, v: AlertRouteDraft[K]) => setEditing((c) => (c ? { ...c, draft: { ...c.draft, [k]: v } } : c))
  const activePeople = data.people.filter((p) => p.is_active)

  return (
    <div className="space-y-6">
      <PageHeader title="Alert routing"
        subtitle="Who gets each alert email (suspended, switched back on, blocked again, not stopped yet, found, missing, access without authority). For an alert about an agent, its own routes are used if any cover the alert; otherwise its department's; otherwise the default route. Changes apply to the next alert."
        actions={<Button onClick={() => { setFormError(null); setEditing({ id: null, draft: emptyRoute() }) }}><Plus /> Add route</Button>} />
      <p className="text-muted-foreground text-sm">Approval requests are routed separately, on <Link to="/routing" className="underline">Routing</Link>.</p>

      <ErrorBox message={actionError} />
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">{notice}</p>}

      <ol className="divide-y rounded-lg border" data-testid="alert-routes">
        {data.routes.map((r, i) => (
          <li key={r.id} className={`flex flex-wrap items-center gap-3 p-3 ${r.is_active ? '' : 'opacity-60'}`} data-testid="alert-route" data-scope={r.scope}>
            <span className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium ${r.scope === 'default' ? 'border' : 'bg-muted'}`}>
              {r.scope === 'default' ? '↳' : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {r.scope === 'default' ? 'Otherwise: the default route' : r.name}
                {!r.is_active && <span className="text-muted-foreground ml-2 text-xs">(off)</span>}
              </div>
              <div className="text-muted-foreground text-sm">{describeTarget(r, data.names)} · {describeEvents(r.events)}</div>
              <div className="text-sm">→ <span className="font-medium" data-testid="alert-route-recipients">{describeRecipients(r, data.peopleNames)}</span></div>
            </div>
            <div className="flex gap-1">
              <Button size="icon" variant="ghost" aria-label={`Edit ${r.scope === 'default' ? 'the default route' : r.name}`} onClick={() => {
                const { id, updated_at: _u, ...draft } = r
                setFormError(null); setEditing({ id, draft })
              }}><Pencil /></Button>
              {r.scope !== 'default' && (
                <Button size="icon" variant="ghost" aria-label={`Delete ${r.name}`} className="text-red-700 dark:text-red-400" onClick={() => setDeleting(r)}><Trash2 /></Button>
              )}
            </div>
          </li>
        ))}
      </ol>

      <AlertTester agents={data.agents} />

      <Dialog open={editing !== null} onOpenChange={(o) => { if (!o) setEditing(null) }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <form onSubmit={save} className="space-y-4" noValidate>
            <DialogHeader>
              <DialogTitle>{editing?.draft.scope === 'default' ? 'Edit the default route' : editing?.id ? 'Edit route' : 'Add route'}</DialogTitle>
              <DialogDescription>
                {editing?.draft.scope === 'default'
                  ? 'Used for every alert no agent or department route covers. Add a designated person here to copy them on everything.'
                  : 'Covers the alerts you tick, for one department or one agent. An agent route is checked before its department\'s.'}
              </DialogDescription>
            </DialogHeader>
            {editing && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="ar-name">Route name</Label>
                  <Input id="ar-name" value={editing.draft.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Payments risk" />
                </div>
                {editing.draft.scope !== 'default' && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="ar-scope">Applies to</Label>
                      <select id="ar-scope" className={selectClass} value={editing.draft.scope}
                        onChange={(e) => set('scope', e.target.value as 'department' | 'agent')}>
                        <option value="department">A department</option>
                        <option value="agent">One agent</option>
                      </select>
                    </div>
                    {editing.draft.scope === 'department' ? (
                      <div className="space-y-1.5">
                        <Label htmlFor="ar-dept">Department</Label>
                        <select id="ar-dept" className={selectClass} value={editing.draft.department_id ?? ''} onChange={(e) => set('department_id', e.target.value || null)}>
                          <option value="">Choose…</option>
                          {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <Label htmlFor="ar-agent">Agent</Label>
                        <select id="ar-agent" className={selectClass} value={editing.draft.agent_id ?? ''} onChange={(e) => set('agent_id', e.target.value || null)}>
                          <option value="">Choose…</option>
                          {data.agents.filter((a) => a.status !== 'retired').map((a) => <option key={a.id} value={a.id}>{a.agent_code} {a.name}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                )}
                {editing.draft.scope !== 'default' && (
                  <fieldset className="space-y-2 rounded-md border p-3">
                    <legend className="px-1 text-sm font-medium">Which alerts</legend>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="size-4" checked={editing.draft.events.length === 0} onChange={(e) => set('events', e.target.checked ? [] : ['suspended'])} />
                      All alerts
                    </label>
                    {editing.draft.events.length > 0 && ALERT_EVENTS.map((ev) => (
                      <label key={ev.key} className="flex items-center gap-2 pl-6 text-sm">
                        <input type="checkbox" className="size-4" checked={editing.draft.events.includes(ev.key)}
                          onChange={(e) => {
                            const next = e.target.checked ? [...editing.draft.events, ev.key] : editing.draft.events.filter((x) => x !== ev.key)
                            set('events', next.length ? (next as AlertEvent[]) : editing.draft.events)
                          }} />
                        {ev.label}
                      </label>
                    ))}
                  </fieldset>
                )}
                <fieldset className="space-y-2 rounded-md border p-3">
                  <legend className="px-1 text-sm font-medium">Send to</legend>
                  {([['to_admins', 'Every admin'], ['to_business_owner', "The agent's business owner"], ['to_technical_owner', "The agent's technical owner"]] as const).map(([k, label]) => (
                    <label key={k} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="size-4" checked={editing.draft[k]} onChange={(e) => set(k, e.target.checked)} /> {label}
                    </label>
                  ))}
                  <div className="space-y-1 pt-1">
                    <div className="text-sm font-medium">{editing.draft.scope === 'default' ? 'Designated people' : 'Named people'}</div>
                    <div className="max-h-44 space-y-1 overflow-y-auto rounded border p-2" data-testid="alert-route-people">
                      {activePeople.map((p) => (
                        <label key={p.id} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" className="size-4" aria-label={p.full_name} checked={editing.draft.people.includes(p.id)}
                            onChange={(e) => set('people', e.target.checked ? [...editing.draft.people, p.id] : editing.draft.people.filter((x) => x !== p.id))} />
                          <span>{p.full_name}{p.job_title && <span className="text-muted-foreground"> · {p.job_title}</span>}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  {editing.draft.scope !== 'default' && (
                    <label className="flex items-center gap-2 pt-1 text-sm">
                      <input type="checkbox" className="size-4" checked={editing.draft.also_default} onChange={(e) => set('also_default', e.target.checked)} />
                      Also everyone on the default route
                    </label>
                  )}
                </fieldset>
                {editing.draft.scope !== 'default' && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="size-4" checked={editing.draft.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Route is on
                  </label>
                )}
                <ErrorBox message={formError} />
              </>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="submit" disabled={busy} data-testid="save-alert-route">{busy ? 'Saving…' : 'Save route'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{deleting?.name}"?</DialogTitle>
            <DialogDescription>Its alerts go to the next route that covers them. The deletion is recorded in the audit trail.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={async () => {
              const r = deleting
              setDeleting(null)
              if (!r) return
              setBusy(true); setActionError(null); setNotice(null)
              try { await api.deleteAlertRoute(r.id); await reload(); setNotice(`Deleted "${r.name}".`) } catch (e) { setActionError(errorMessage(e)) } finally { setBusy(false) }
            }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AlertTester({ agents }: { agents: { id: string; agent_code: string; name: string; status: string }[] }) {
  const [agentId, setAgentId] = useState('')
  const [event, setEvent] = useState<AlertEvent>('suspended')
  const [result, setResult] = useState<AlertRoutePreview[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useMemo(() => agents.filter((a) => a.status !== 'retired'), [agents])
  async function test(e: FormEvent) {
    e.preventDefault()
    if (!agentId) return
    setError(null)
    try { setResult(await api.previewAlertRoute(agentId, event)) } catch (err) { setError(errorMessage(err)) }
  }
  return (
    <section className="bg-card space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="flex items-center gap-2 font-semibold"><BellRing className="size-4" /> Test an alert</h2>
        <p className="text-muted-foreground text-xs">See who would be emailed, and why, without sending anything.</p>
      </div>
      <form onSubmit={test} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <select aria-label="Agent" className={selectClass} value={agentId} onChange={(e) => { setAgentId(e.target.value); setResult(null) }}>
          <option value="">Choose an agent</option>
          {live.map((a) => <option key={a.id} value={a.id}>{a.agent_code} {a.name}</option>)}
        </select>
        <select aria-label="Alert" className={selectClass} value={event} onChange={(e) => { setEvent(e.target.value as AlertEvent); setResult(null) }}>
          {ALERT_EVENTS.map((ev) => <option key={ev.key} value={ev.key}>{ev.label}</option>)}
        </select>
        <Button type="submit" variant="outline" disabled={!agentId}><FlaskConical /> Test</Button>
      </form>
      <ErrorBox message={error} />
      {result && (
        <div className="bg-muted rounded-md p-3 text-sm" data-testid="alert-route-result">
          {result.length === 0 ? 'Nobody would be emailed.' : (
            <ul className="space-y-1">
              {result.map((r) => (
                <li key={r.name} data-testid="alert-route-person">
                  <span className="font-medium">{r.name}</span>{r.job_title && <span className="text-muted-foreground"> · {r.job_title}</span>}
                  <span className="text-muted-foreground text-xs"> · route "{r.route}": {r.because}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
