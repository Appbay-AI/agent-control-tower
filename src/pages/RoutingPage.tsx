import { ArrowDown, ArrowUp, Clock, FlaskConical, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { ErrorBox, LoadingRows, PageHeader, selectClass } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { DATA_LABEL, errorMessage, RISK_LABEL } from '@/lib/format'
import { describeConditions, describeOverdue, emptyRule, reorder, ruleProblem, secondApproval, type SecondApprovalContext } from '@/lib/routing'
import { durationText, URGENCIES } from '@/lib/sla'
import type { ActionUrgency, DataClassification, RiskTier, RoutingPreview, RoutingRule, RoutingRuleDraft, SlaSetting } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'

const num = (v: string) => (v.trim() === '' ? null : Number(v))

export function RoutingPage() {
  const { hasRole } = useAuth()
  const isAdmin = hasRole('admin')
  const { data, error, loading, reload } = useAsync(async () => {
    const [rules, agents, departments, approvers, sla, killSwitch, scopes] = await Promise.all([
      api.routingRules(), api.agents(), api.departments(), api.approvers(), api.slaSettings(), api.killSwitchSettings(), api.approverScopes(),
    ])
    const active = new Set(approvers.map((p) => p.id))
    const byDept = new Map<string, string[]>()
    for (const sc of scopes) if (active.has(sc.user_id)) byDept.set(sc.department_id, [...(byDept.get(sc.department_id) ?? []), sc.user_id])
    const second: SecondApprovalContext = {
      agents: new Map(agents.map((a) => [a.id, { agent_code: a.agent_code, risk_tier: a.risk_tier, department_id: a.department_id,
        owners: [a.business_owner_id, a.technical_owner_id, a.created_by] }])),
      departments: new Map(departments.map((d) => [d.id, d.name])),
      people: new Map(approvers.map((p) => [p.id, p.full_name])),
      scopes: byDept,
    }
    return {
      rules, agents, departments, approvers, sla, killSwitch, second,
      names: {
        agents: new Map(agents.map((a) => [a.id, `${a.agent_code} ${a.name}`])),
        departments: new Map(departments.map((d) => [d.id, d.name])),
        people: new Map(approvers.map((p) => [p.id, p.full_name])),
      },
    }
  })
  const [editing, setEditing] = useState<{ id: string | null; draft: RoutingRuleDraft } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<RoutingRule | null>(null)

  const nextPriority = useMemo(() => ((data?.rules.at(-1)?.priority ?? 0) + 10), [data])

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true); setActionError(null); setNotice(null)
    try { await fn(); await reload(); if (ok) setNotice(ok) } catch (e) { setActionError(errorMessage(e)) } finally { setBusy(false) }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    const problem = ruleProblem(editing.draft)
    if (problem) { setFormError(problem); return }
    setBusy(true); setFormError(null)
    try {
      const d = editing.draft
      const hasBand = d.min_amount != null || d.max_amount != null
      await api.saveRoutingRule(editing.id, { ...d, name: d.name.trim(), currency: hasBand ? d.currency : null })
      setEditing(null)
      await reload()
      setNotice('Saved. New waiting requests follow it straight away; use "Apply to waiting requests" for ones already waiting.')
    } catch (err) { setFormError(errorMessage(err)) } finally { setBusy(false) }
  }

  if (error) return <ErrorBox message={error} />
  if (loading && !data) return <LoadingRows />
  if (!data) return null
  const set = <K extends keyof RoutingRuleDraft>(k: K, v: RoutingRuleDraft[K]) =>
    setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, [k]: v } } : cur))

  return (
    <div className="space-y-6">
      <PageHeader title="Approval routing"
        subtitle="Who approves an action request that waits for a human. Rules are checked from the top; the first match wins. If none matches, any approver for the agent's department may decide. A Critical agent's request needs a second approval from a different approver, shown under each rule."
        actions={isAdmin && (
          <>
            <Button variant="outline" disabled={busy} onClick={() => run(async () => {
              const n = await api.reroutePending()
              setNotice(n === 1 ? '1 waiting request was re-routed.' : `${n} waiting requests were re-routed.`)
            })}><RefreshCw /> Apply to waiting requests</Button>
            <Button onClick={() => { setFormError(null); setEditing({ id: null, draft: emptyRule(nextPriority) }) }}><Plus /> Add rule</Button>
          </>
        )} />

      <ErrorBox message={actionError} />
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">{notice}</p>}

      <ol className="divide-y rounded-lg border">
        {data.rules.length === 0 && (
          <li className="text-muted-foreground p-4 text-sm">No rules yet. Every waiting request goes to the department's approvers.</li>
        )}
        {data.rules.map((r, i) => (
          <li key={r.id} className={`flex flex-wrap items-center gap-3 p-3 ${r.is_active ? '' : 'opacity-60'}`}>
            <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{r.name}{!r.is_active && <span className="text-muted-foreground ml-2 text-xs">(off)</span>}</div>
              <div className="text-muted-foreground text-sm">{describeConditions(r, data.names)}</div>
              {(() => {
                const second = secondApproval(r, data.second)
                return (
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-sm" data-testid="rule-approvals">
                    <dt className="text-muted-foreground">1st approval</dt>
                    <dd className="text-foreground font-medium">{data.names.people.get(r.approver_id) ?? 'An inactive approver'}</dd>
                    <dt className="text-muted-foreground">2nd approval</dt>
                    <dd data-testid="second-approval" className={second.nobody ? 'font-medium text-red-700 dark:text-red-400' : second.when === 'never' ? 'text-muted-foreground' : ''}>{second.text}</dd>
                  </dl>
                )
              })()}
              <div className="text-muted-foreground flex items-center gap-1 text-xs"><Clock className="size-3" aria-hidden /> {describeOverdue(r, data.names.people)}</div>
            </div>
            {isAdmin && (
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" aria-label={`Move ${r.name} up`} disabled={busy || i === 0}
                  onClick={() => run(() => api.setRulePriorities(reorder(data.rules, r.id, -1)))}><ArrowUp /></Button>
                <Button size="icon" variant="ghost" aria-label={`Move ${r.name} down`} disabled={busy || i === data.rules.length - 1}
                  onClick={() => run(() => api.setRulePriorities(reorder(data.rules, r.id, 1)))}><ArrowDown /></Button>
                <Button size="icon" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => {
                  const { id, ...draft } = r
                  setFormError(null); setEditing({ id, draft: { ...draft, currency: draft.currency ?? 'GBP' } })
                }}><Pencil /></Button>
                <Button size="icon" variant="ghost" aria-label={`Delete ${r.name}`} className="text-red-700 dark:text-red-400"
                  onClick={() => setDeleting(r)}><Trash2 /></Button>
              </div>
            )}
          </li>
        ))}
        <li className="text-muted-foreground flex items-center gap-3 p-3 text-sm">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border text-xs">↳</span>
          Otherwise: any approver for the agent's department, within the default time; else it expires. For a Critical agent, then a second, different approver for its department.
        </li>
      </ol>

      <TimeLimits settings={data.sla} canEdit={isAdmin} onSaved={reload} />
      <KillSwitchSettings on={Boolean(data.killSwitch?.critical_needs_second)} canEdit={isAdmin} onSaved={reload} />

      <RoutingTester agents={data.agents} />

      <Dialog open={editing !== null} onOpenChange={(o) => { if (!o) setEditing(null) }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <form onSubmit={save} className="space-y-4" noValidate>
            <DialogHeader>
              <DialogTitle>{editing?.id ? 'Edit rule' : 'Add rule'}</DialogTitle>
              <DialogDescription>Leave a condition blank to match anything.</DialogDescription>
            </DialogHeader>
            {editing && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="r-name">Rule name</Label>
                  <Input id="r-name" value={editing.draft.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Large payments" />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="r-dept">Department</Label>
                    <select id="r-dept" className={selectClass} value={editing.draft.department_id ?? ''} onChange={(e) => set('department_id', e.target.value || null)}>
                      <option value="">Any</option>
                      {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="r-agent">One agent only</Label>
                    <select id="r-agent" className={selectClass} value={editing.draft.agent_id ?? ''} onChange={(e) => set('agent_id', e.target.value || null)}>
                      <option value="">Any</option>
                      {data.agents.filter((a) => a.status !== 'retired').map((a) => <option key={a.id} value={a.id}>{a.agent_code} {a.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="r-min">Amount from</Label>
                    <Input id="r-min" inputMode="decimal" value={editing.draft.min_amount ?? ''} onChange={(e) => set('min_amount', num(e.target.value))} placeholder="Any" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="r-max">Up to (not including)</Label>
                    <Input id="r-max" inputMode="decimal" value={editing.draft.max_amount ?? ''} onChange={(e) => set('max_amount', num(e.target.value))} placeholder="No limit" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="r-cur">Currency</Label>
                    <Input id="r-cur" maxLength={3} value={editing.draft.currency ?? ''} onChange={(e) => set('currency', e.target.value.toUpperCase())} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="r-data">Agent touches</Label>
                    <select id="r-data" className={selectClass} value={editing.draft.data_classification ?? ''}
                      onChange={(e) => set('data_classification', (e.target.value || null) as DataClassification | null)}>
                      <option value="">Any data</option>
                      {Object.entries(DATA_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="r-risk">Risk tier at least</Label>
                    <select id="r-risk" className={selectClass} value={editing.draft.min_risk_tier ?? ''}
                      onChange={(e) => set('min_risk_tier', (e.target.value || null) as RiskTier | null)}>
                      <option value="">Any</option>
                      {Object.entries(RISK_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="r-prio">Priority (lower is checked first)</Label>
                    <Input id="r-prio" inputMode="numeric" value={editing.draft.priority} onChange={(e) => set('priority', Number(e.target.value))} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="r-approver">Approved by</Label>
                  <select id="r-approver" className={selectClass} value={editing.draft.approver_id} onChange={(e) => set('approver_id', e.target.value)}>
                    <option value="">Choose an approver</option>
                    {data.approvers.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.job_title ? ` · ${p.job_title}` : ''}</option>)}
                  </select>
                  <p className="text-muted-foreground text-xs">If this person owns or created the agent, the rule is skipped and the next one is used.</p>
                </div>
                <fieldset className="space-y-3 rounded-md border p-3">
                  <legend className="px-1 text-sm font-medium">Time to decide</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="r-sla">Minutes</Label>
                      <Input id="r-sla" inputMode="numeric" value={editing.draft.sla_minutes ?? ''} placeholder="Default for its urgency"
                        onChange={(e) => set('sla_minutes', num(e.target.value))} />
                      {editing.draft.sla_minutes != null && editing.draft.sla_minutes > 0 && Number.isInteger(editing.draft.sla_minutes) &&
                        <p className="text-muted-foreground text-xs">= {durationText(editing.draft.sla_minutes)}</p>}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="r-overdue">If nobody decides in time</Label>
                      <select id="r-overdue" className={selectClass} value={editing.draft.on_overdue}
                        onChange={(e) => set('on_overdue', e.target.value as 'reject' | 'escalate')}>
                        <option value="reject">It expires (the agent is told no)</option>
                        <option value="escalate">Escalate once to…</option>
                      </select>
                    </div>
                  </div>
                  {editing.draft.on_overdue === 'escalate' && (
                    <div className="space-y-1.5">
                      <Label htmlFor="r-escalate-to">Escalate to</Label>
                      <select id="r-escalate-to" className={selectClass} value={editing.draft.overdue_escalate_to ?? ''}
                        onChange={(e) => set('overdue_escalate_to', e.target.value || null)}>
                        <option value="">Choose an approver</option>
                        {data.approvers.filter((p) => p.id !== editing.draft.approver_id).map((p) =>
                          <option key={p.id} value={p.id}>{p.full_name}{p.job_title ? ` · ${p.job_title}` : ''}</option>)}
                      </select>
                      <p className="text-muted-foreground text-xs">They get a fresh time limit. If they don't decide either, it expires.</p>
                    </div>
                  )}
                </fieldset>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4" checked={editing.draft.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Rule is on
                </label>
                <ErrorBox message={formError} />
              </>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save rule'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{deleting?.name}"?</DialogTitle>
            <DialogDescription>Requests it already routed keep their approver. The deletion is recorded in the audit trail.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => {
              const r = deleting
              setDeleting(null)
              if (r) void run(() => api.deleteRoutingRule(r.id), `Deleted "${r.name}".`)
            }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Task 2.9: the default time to decide, by urgency. Used when a request's rule sets no time of its own. */
// Task 4.1: whether suspending a Critical agent needs a second person.
function KillSwitchSettings({ on, canEdit, onSaved }: { on: boolean; canEdit: boolean; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function change(value: boolean) {
    setBusy(true); setError(null)
    try { await api.setKillSwitchSettings(value); await onSaved() } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <section className="bg-card space-y-3 rounded-lg border p-4" data-testid="kill-switch-settings">
      <div>
        <h2 className="font-semibold">Kill switch</h2>
        <p className="text-muted-foreground text-xs">
          Admins, an agent's owners and approvers for its department can suspend a Live agent at once, with a reason.
          For Critical agents you can require a second person to confirm.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={on} disabled={!canEdit || busy} onChange={(e) => change(e.target.checked)} />
        Suspending a Critical agent needs a second person
      </label>
      <ErrorBox message={error} />
    </section>
  )
}

function TimeLimits({ settings, canEdit, onSaved }: { settings: SlaSetting[]; canEdit: boolean; onSaved: () => Promise<void> }) {
  const current = (u: ActionUrgency) => settings.find((s) => s.urgency === u)?.minutes ?? 0
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(URGENCIES.map((u) => [u, String(current(u))])))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const changed = URGENCIES.filter((u) => values[u] !== String(current(u)))

  async function save(e: FormEvent) {
    e.preventDefault()
    const bad = changed.find((u) => !/^\d+$/.test(values[u]) || Number(values[u]) < 1 || Number(values[u]) > 43200)
    if (bad) { setMsg({ ok: false, text: `${bad[0].toUpperCase()}${bad.slice(1)}: enter whole minutes from 1 to 43,200.` }); return }
    setBusy(true); setMsg(null)
    try {
      for (const u of changed) await api.saveSlaSetting(u, Number(values[u]))
      await onSaved()
      setMsg({ ok: true, text: 'Saved. New waiting requests use these limits.' })
    } catch (err) { setMsg({ ok: false, text: errorMessage(err) }) } finally { setBusy(false) }
  }

  return (
    <section className="bg-card space-y-3 rounded-lg border p-4" data-testid="time-limits">
      <div>
        <h2 className="font-semibold">Default time to decide</h2>
        <p className="text-muted-foreground text-xs">
          Used when the rule sets no time of its own. When the time is up, a request expires and the agent is told no,
          unless its rule says to escalate it.
        </p>
      </div>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-4">
        {URGENCIES.map((u) => (
          <div key={u} className="space-y-1">
            <Label htmlFor={`sla-${u}`} className="capitalize">{u} (minutes)</Label>
            <Input id={`sla-${u}`} inputMode="numeric" disabled={!canEdit} value={values[u]} onChange={(e) => setValues({ ...values, [u]: e.target.value })} />
            {/^\d+$/.test(values[u]) && Number(values[u]) > 0 && <p className="text-muted-foreground text-xs">= {durationText(Number(values[u]))}</p>}
          </div>
        ))}
        {canEdit && (
          <div className="flex items-center gap-3 sm:col-span-4">
            <Button type="submit" variant="outline" disabled={busy || changed.length === 0}>Save time limits</Button>
            {msg && <span role="status" className={msg.ok ? 'text-sm text-emerald-700 dark:text-emerald-400' : 'text-destructive text-sm'}>{msg.text}</span>}
          </div>
        )}
      </form>
    </section>
  )
}

function RoutingTester({ agents }: { agents: { id: string; agent_code: string; name: string; status: string; risk_tier: string }[] }) {
  const [agentId, setAgentId] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('GBP')
  const [result, setResult] = useState<RoutingPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function test(e: FormEvent) {
    e.preventDefault()
    if (!agentId) return
    setError(null)
    try { setResult(await api.previewRouting(agentId, num(amount), amount.trim() ? currency : null)) } catch (err) { setError(errorMessage(err)) }
  }

  return (
    <section className="bg-card space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="font-semibold">Test a request</h2>
        <p className="text-muted-foreground text-xs">See who would approve, without sending anything.</p>
      </div>
      <form onSubmit={test} className="grid gap-2 sm:grid-cols-[1fr_9rem_5rem_auto]">
        <select aria-label="Agent" className={selectClass} value={agentId} onChange={(e) => { setAgentId(e.target.value); setResult(null) }}>
          <option value="">Choose an agent</option>
          {agents.filter((a) => a.status !== 'retired').map((a) => <option key={a.id} value={a.id}>{a.agent_code} {a.name}</option>)}
        </select>
        <Input aria-label="Amount" inputMode="decimal" placeholder="Amount" value={amount} onChange={(e) => { setAmount(e.target.value); setResult(null) }} />
        <Input aria-label="Currency" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        <Button type="submit" variant="outline" disabled={!agentId}><FlaskConical /> Test</Button>
      </form>
      <ErrorBox message={error} />
      {result && (
        <div className="bg-muted rounded-md p-3 text-sm" data-testid="routing-result">
          <div className="font-medium">
            {result.approver_name ? `${result.approver_name} approves (rule "${result.rule_name}")`
              : result.department_approvers.length ? `Any of: ${result.department_approvers.join(', ')}`
                : 'Nobody can approve this yet: the department has no approvers.'}
          </div>
          {agents.find((a) => a.id === agentId)?.risk_tier === 'critical' && (
            <div className="mt-1" data-testid="routing-second">
              {(() => {
                const first = result.approver_name
                const others = result.department_approvers.filter((n) => n !== first)
                return (first ? others.length === 0 : others.length < 2)
                  ? 'Then a second approval: nobody else approves for its department, so it would wait until it expires.'
                  : first
                    ? `Then a second approval (Critical agent): any of ${others.join(', ')}`
                    : `Then a second approval (Critical agent): any other one of them`
              })()}
            </div>
          )}
          <div className="text-muted-foreground mt-1 text-xs">{result.note}</div>
        </div>
      )}
    </section>
  )
}
