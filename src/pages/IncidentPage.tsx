// Task 4.5: one incident case. What happened, its owner and time to resolve, the case fields (impact, containment,
// root cause, remediation), the status (Open → Contained → Resolved, or reopened), severity and hand-over with a
// reason, and the log of notes and changes. Task 4.9: closing needs a named approver (asked here; only they can close it).
import { ArrowLeft } from 'lucide-react'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { RiskBadge } from '@/components/badges'
import { IncidentStatusBadge } from '@/components/IncidentList'
import { ErrorBox, Field, LoadingRows, selectClass } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { errorMessage, formatDateTime, formatMoney, RISK_LABEL } from '@/lib/format'
import { INCIDENT_SOURCE_LABEL, incidentDue, missingFor, PERSONAL_DATA_LABEL, ROOT_CAUSE_LABEL, SEVERITIES } from '@/lib/incidents'
import type { Incident, IncidentUpdate, RiskTier, RootCause } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'
import { cn } from '@/lib/utils'

/** The case fields as the form holds them (strings; "" = empty). */
export type CaseDraft = Record<'impact' | 'customers_affected' | 'financial_impact' | 'personal_data' | 'containment' |
  'root_cause_category' | 'root_cause' | 'remediation', string>

export function draftOf(i: Incident): CaseDraft {
  return {
    impact: i.impact ?? '', customers_affected: i.customers_affected?.toString() ?? '', financial_impact: i.financial_impact?.toString() ?? '',
    personal_data: i.personal_data ?? '', containment: i.containment ?? '', root_cause_category: i.root_cause_category ?? '',
    root_cause: i.root_cause ?? '', remediation: i.remediation ?? '',
  }
}

/** Only the fields that differ from what is saved (trimmed), ready for incident_save_fields. */
export function changedFields(saved: CaseDraft, draft: CaseDraft): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(draft) as (keyof CaseDraft)[]) if (draft[k].trim() !== saved[k].trim()) out[k] = draft[k].trim()
  return out
}

type Dialogs = { kind: 'status'; to: Incident['status'] } | { kind: 'severity' } | { kind: 'owner' } | null

export function IncidentPage() {
  const { id } = useParams()
  const { session } = useAuth()
  const me = session!.user.id
  const { data, error, loading, reload } = useAsync(async () => {
    const incident = await api.incident(id!)
    const [agent, profiles, updates, canWork] = await Promise.all([
      api.agent(incident.agent_id), api.allProfiles(), api.incidentUpdates(incident.id), api.canWorkIncident(incident.id),
    ])
    return { incident, agent, profiles, updates, canWork, people: new Map(profiles.map((p) => [p.id, p.full_name])) }
  }, [id])
  const [dialog, setDialog] = useState<Dialogs>(null)

  const back = (
    <Link to="/incidents" className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline">
      <ArrowLeft className="size-4" /> Incidents
    </Link>
  )
  if (error) return <div className="space-y-4"><ErrorBox message={error} />{back}</div>
  if (loading && !data) return <LoadingRows rows={8} />
  if (!data) return null

  const { incident: i, agent: a, updates, canWork, people } = data
  const name = (uid: string | null) => (uid ? people.get(uid) ?? 'Former user' : 'nobody')
  const due = incidentDue(i)
  const editable = canWork && i.status !== 'closed'

  return (
    <div className="space-y-6">
      {back}
      <div className="space-y-2">
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono">{i.incident_code}</span>
          <RiskBadge tier={i.severity} />
          <IncidentStatusBadge status={i.status} />
          {due && <span data-testid="incident-due" className={cn(due.overdue && 'font-medium text-red-700 dark:text-red-400')}>{due.text}</span>}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight break-words" data-testid="incident-title">{i.title}</h1>
        <p className="text-sm">
          Agent <Link to={`/agents/${a.id}`} className="font-medium hover:underline">{a.agent_code} {a.name}</Link>
          {' · '}Owner <span className="font-medium" data-testid="incident-owner">{name(i.owner_id)}</span>
          {i.owner_reason && <span className="text-muted-foreground"> ({i.owner_reason})</span>}
        </p>
        <p className="text-muted-foreground text-xs">
          {INCIDENT_SOURCE_LABEL[i.source]}: {i.reporter} · opened {formatDateTime(i.opened_at)} · resolve by {formatDateTime(i.due_at)}
          {i.occurred_at && ` · happened ${formatDateTime(i.occurred_at)}`}
          {i.contained_at && ` · contained ${formatDateTime(i.contained_at)}`}
          {i.resolved_at && ` · resolved ${formatDateTime(i.resolved_at)}`}
        </p>
        {i.description && i.description !== i.title && <p className="text-sm whitespace-pre-wrap break-words">{i.description}</p>}
      </div>

      {editable && <Actions incident={i} open={setDialog} />}

      <Closure incident={i} me={me} canAsk={canWork} name={name} onDone={reload} />

      <CaseFields key={i.updated_at} incident={i} editable={editable} onSaved={reload} />

      <Log updates={updates} name={name} incidentId={i.id} canNote={editable} onAdded={reload} />

      {dialog && <ActionDialog dialog={dialog} incident={i} people={data.profiles.filter((p) => p.is_active && p.id !== i.owner_id)}
        me={me} close={() => setDialog(null)} onDone={reload} />}
    </div>
  )
}

function Actions({ incident: i, open }: { incident: Incident; open: (d: Dialogs) => void }) {
  const toContained = missingFor(i, 'contained')
  const toResolved = missingFor(i, 'resolved')
  return (
    <section className="bg-card space-y-2 rounded-lg border p-4" data-testid="incident-actions">
      <div className="flex flex-wrap gap-2">
        {i.status === 'open' && (
          <Button onClick={() => open({ kind: 'status', to: 'contained' })} disabled={toContained.length > 0} data-testid="mark-contained">Mark contained</Button>
        )}
        {(i.status === 'open' || i.status === 'contained') && (
          <Button onClick={() => open({ kind: 'status', to: 'resolved' })} disabled={toResolved.length > 0} data-testid="mark-resolved">Mark resolved</Button>
        )}
        {i.status === 'contained' && <Button variant="outline" onClick={() => open({ kind: 'status', to: 'open' })}>Back to open</Button>}
        {i.status === 'resolved' && <Button variant="outline" onClick={() => open({ kind: 'status', to: 'open' })} data-testid="reopen">Reopen</Button>}
        <Button variant="outline" onClick={() => open({ kind: 'severity' })}>Change severity</Button>
        <Button variant="outline" onClick={() => open({ kind: 'owner' })}>Hand over</Button>
      </div>
      {i.status !== 'resolved' && toResolved.length > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="incident-missing">
          To mark it {i.status === 'open' && toContained.length > 0 ? 'contained, fill in containment; to mark it ' : ''}resolved, fill in: {toResolved.join(', ')}.
        </p>
      )}
    </section>
  )
}

/** Task 4.9: closing needs a named approver. The person working it asks; only the named approver can close it. */
export function closureState(i: Incident, me: string): 'closed' | 'decide' | 'waiting' | 'ask' | 'none' {
  if (i.status === 'closed') return 'closed'
  if (i.status !== 'resolved') return 'none'
  if (i.closure_approver_id === me) return 'decide'
  if (i.closure_approver_id) return 'waiting'
  return 'ask'
}

function Closure({ incident: i, me, canAsk, name, onDone }: {
  incident: Incident; me: string; canAsk: boolean; name: (id: string | null) => string; onDone: () => Promise<void>
}) {
  const state = closureState(i, me)
  const [dialog, setDialog] = useState<'ask' | 'approve' | 'reject' | null>(null)
  if (state === 'none' || (state === 'ask' && !canAsk)) return null
  const asked = i.closure_requested_by && (
    <>{name(i.closure_requested_by)} asked {name(i.closure_approver_id)} on {formatDateTime(i.closure_requested_at!)}{i.closure_note && <>: “{i.closure_note}”</>}</>
  )
  return (
    <section className="bg-card space-y-2 rounded-lg border p-4 text-sm" data-testid="incident-closure" data-state={state}>
      <h2 className="font-semibold">Closing</h2>
      {state === 'closed' && (
        <p data-testid="closure-done">Closed {i.closed_at && formatDateTime(i.closed_at)}{i.closed_by && <>, approved by <span className="font-medium">{name(i.closed_by)}</span></>}.</p>
      )}
      {state === 'ask' && (
        <>
          <p className="text-muted-foreground text-xs">The case is complete. Closing it needs a named approver: an admin or an approver for the agent's department, not you.</p>
          <Button onClick={() => setDialog('ask')} data-testid="ask-close">Ask to close</Button>
        </>
      )}
      {state === 'waiting' && <p data-testid="closure-waiting">Waiting for <span className="font-medium">{name(i.closure_approver_id)}</span> to approve closing. {asked}</p>}
      {state === 'decide' && (
        <>
          <p>{asked}. You were named to approve closing it.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setDialog('approve')} data-testid="approve-close">Approve and close</Button>
            <Button variant="outline" onClick={() => setDialog('reject')} data-testid="reject-close">Turn down</Button>
          </div>
        </>
      )}
      {dialog && <ClosureDialog kind={dialog} incident={i} close={() => setDialog(null)} onDone={onDone} />}
    </section>
  )
}

function ClosureDialog({ kind, incident: i, close, onDone }: { kind: 'ask' | 'approve' | 'reject'; incident: Incident; close: () => void; onDone: () => Promise<void> }) {
  const { data: approvers } = useAsync(() => (kind === 'ask' ? api.incidentClosureApprovers(i.id) : Promise.resolve([])), [kind, i.id])
  const [approver, setApprover] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const needsText = kind === 'reject'
  async function go() {
    setBusy(true); setErr(null)
    try {
      if (kind === 'ask') await api.requestIncidentClosure(i.id, approver, text.trim() || null)
      else await api.decideIncidentClosure(i.id, kind === 'approve', text.trim() || null)
      close()
      await onDone()
    } catch (e) { setErr(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === 'ask' ? 'Ask to close' : kind === 'approve' ? `Close ${i.incident_code}?` : 'Turn down closing?'}</DialogTitle>
          <DialogDescription>
            {kind === 'ask' && 'Choose who approves the closure. They are told on their phone; only they can close it.'}
            {kind === 'approve' && 'The incident is closed and stays on record with your name as the approver.'}
            {kind === 'reject' && 'It stays resolved. Say what is missing, so the log shows it.'}
          </DialogDescription>
        </DialogHeader>
        {kind === 'ask' && (
          <select className={selectClass} value={approver} onChange={(e) => setApprover(e.target.value)} aria-label="Approver">
            <option value="">Choose an approver…</option>
            {(approvers ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.job_title ? ` · ${p.job_title}` : ''}</option>)}
          </select>
        )}
        <Field label={needsText ? 'Reason (recorded in the log)' : 'Note (optional)'}>
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label={needsText ? 'Reason' : 'Note'} />
        </Field>
        <ErrorBox message={err} />
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button onClick={go} disabled={busy || (kind === 'ask' && !approver) || (needsText && !text.trim())} data-testid="confirm-closure">
            {kind === 'ask' ? 'Ask' : kind === 'approve' ? 'Approve and close' : 'Turn down'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CaseFields({ incident: i, editable, onSaved }: { incident: Incident; editable: boolean; onSaved: () => Promise<void> }) {
  const saved = useMemo(() => draftOf(i), [i])
  const [draft, setDraft] = useState<CaseDraft>(saved)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const changes = changedFields(saved, draft)
  const set = (k: keyof CaseDraft) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value })
  const currency = i.financial_currency ?? 'GBP'

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setMsg(null)
    try {
      await api.saveIncidentFields(i.id, changes, note.trim() || null)
      setNote('')
      await onSaved()
    } catch (err) { setMsg({ ok: false, text: errorMessage(err) }) } finally { setBusy(false) }
  }

  if (!editable) {
    const text = (v: string | null) => v ? <p className="whitespace-pre-wrap break-words">{v}</p> : <span className="text-muted-foreground">Not filled in</span>
    return (
      <div className="grid gap-4 md:grid-cols-2" data-testid="incident-case">
        <Section title="Impact">
          {text(i.impact)}
          <dl className="text-muted-foreground mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
            <dt>Customers affected</dt><dd>{i.customers_affected ?? '—'}</dd>
            <dt>Money involved</dt><dd>{i.financial_impact !== null ? formatMoney(i.financial_impact, currency) : '—'}</dd>
            <dt>Personal data involved</dt><dd>{i.personal_data ? PERSONAL_DATA_LABEL[i.personal_data] : '—'}</dd>
          </dl>
        </Section>
        <Section title="Containment">{text(i.containment)}</Section>
        <Section title="Root cause">
          {i.root_cause_category && <p className="text-muted-foreground mb-1 text-xs">{ROOT_CAUSE_LABEL[i.root_cause_category]}</p>}
          {text(i.root_cause)}
        </Section>
        <Section title="Remediation">{text(i.remediation)}</Section>
      </div>
    )
  }

  return (
    <form onSubmit={save} className="space-y-4" data-testid="incident-case">
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Impact" hint="What happened to customers, money and data">
          <Textarea rows={3} value={draft.impact} onChange={set('impact')} aria-label="Impact" placeholder="e.g. 12 customers were refunded twice" />
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="inc-customers" className="text-xs">Customers affected</Label>
              <Input id="inc-customers" inputMode="numeric" value={draft.customers_affected} onChange={set('customers_affected')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="inc-money" className="text-xs">Money involved ({currency})</Label>
              <Input id="inc-money" inputMode="decimal" value={draft.financial_impact} onChange={set('financial_impact')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="inc-pii" className="text-xs">Personal data involved</Label>
              <select id="inc-pii" className={selectClass} value={draft.personal_data} onChange={set('personal_data')}>
                <option value="">Choose…</option>
                {(['yes', 'no', 'unknown'] as const).map((v) => <option key={v} value={v}>{PERSONAL_DATA_LABEL[v]}</option>)}
              </select>
            </div>
          </div>
        </Section>
        <Section title="Containment" hint="What was done to stop it, and when">
          <Textarea rows={5} value={draft.containment} onChange={set('containment')} aria-label="Containment" placeholder="e.g. Agent suspended; payments recalled" />
        </Section>
        <Section title="Root cause" hint="Why it happened">
          <select className={cn(selectClass, 'mb-2')} value={draft.root_cause_category} onChange={set('root_cause_category')} aria-label="Root cause category">
            <option value="">Choose a category…</option>
            {(Object.keys(ROOT_CAUSE_LABEL) as RootCause[]).map((k) => <option key={k} value={k}>{ROOT_CAUSE_LABEL[k]}</option>)}
          </select>
          <Textarea rows={3} value={draft.root_cause} onChange={set('root_cause')} aria-label="Root cause" placeholder="e.g. The supplier block list was a day old" />
        </Section>
        <Section title="Remediation" hint="What was fixed, and what stops it happening again">
          <Textarea rows={5} value={draft.remediation} onChange={set('remediation')} aria-label="Remediation" placeholder="e.g. Block list now refreshed hourly" />
        </Section>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input className="sm:max-w-md" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the log (optional)" aria-label="Note for the log" />
        <Button type="submit" disabled={busy || Object.keys(changes).length === 0} data-testid="save-case">Save case</Button>
        {Object.keys(changes).length > 0 && <span className="text-muted-foreground text-xs">Unsaved changes</span>}
      </div>
      <ErrorBox message={msg && !msg.ok ? msg.text : null} />
    </form>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="bg-card space-y-1 rounded-lg border p-4 text-sm">
      <h2 className="font-semibold">{title}</h2>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      <div className="pt-1">{children}</div>
    </section>
  )
}

function Log({ updates, name, incidentId, canNote, onAdded }: {
  updates: IncidentUpdate[]; name: (id: string | null) => string; incidentId: string; canNote: boolean; onAdded: () => Promise<void>
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  async function add(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(null)
    try { await api.addIncidentNote(incidentId, note); setNote(''); await onAdded() } catch (x) { setErr(errorMessage(x)) } finally { setBusy(false) }
  }
  return (
    <section className="space-y-2" data-testid="incident-log">
      <h2 className="font-semibold">Log</h2>
      {updates.length === 0 && <p className="text-muted-foreground text-sm">Nothing yet.</p>}
      <ul className="space-y-2">
        {updates.map((u) => (
          <li key={u.id} className="bg-card rounded-md border p-2 text-sm">
            <div className="text-muted-foreground text-xs">{formatDateTime(u.created_at)} · {u.author_id ? name(u.author_id) : 'Control Tower'}</div>
            <div className="whitespace-pre-wrap break-words">{u.body}</div>
          </li>
        ))}
      </ul>
      {canNote && (
        <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" aria-label="Add a note" />
          <Button type="submit" variant="outline" disabled={busy || !note.trim()}>Add note</Button>
        </form>
      )}
      <ErrorBox message={err} />
    </section>
  )
}

const STATUS_TITLE = { open: 'Move back to Open?', contained: 'Mark as contained?', resolved: 'Mark as resolved?', closed: '' } as const

function ActionDialog({ dialog, incident: i, people, me, close, onDone }: {
  dialog: NonNullable<Dialogs>; incident: Incident; people: { id: string; full_name: string }[]; me: string
  close: () => void; onDone: () => Promise<void>
}) {
  const [text, setText] = useState('')
  const [severity, setSeverity] = useState<RiskTier>(i.severity)
  const [owner, setOwner] = useState(people.find((p) => p.id === me)?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const reopening = dialog.kind === 'status' && dialog.to === 'open'
  const required = dialog.kind !== 'status' || reopening

  async function go() {
    setBusy(true); setErr(null)
    try {
      if (dialog.kind === 'status') await api.setIncidentStatus(i.id, dialog.to, text.trim() || null)
      else if (dialog.kind === 'severity') await api.setIncidentSeverity(i.id, severity, text.trim())
      else await api.reassignIncident(i.id, owner, text.trim())
      close()
      await onDone()
    } catch (e) { setErr(errorMessage(e)) } finally { setBusy(false) }
  }

  const title = dialog.kind === 'status' ? (i.status === 'resolved' && reopening ? 'Reopen this incident?' : STATUS_TITLE[dialog.to])
    : dialog.kind === 'severity' ? 'Change severity' : 'Hand over to someone else'
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {dialog.kind === 'status' && dialog.to === 'resolved' && 'The case is complete. It stays on record; closing it needs a named approver.'}
            {dialog.kind === 'status' && dialog.to === 'contained' && 'The harm has stopped; the root cause and remediation can follow.'}
            {reopening && 'Say why, so the log shows it.'}
            {dialog.kind === 'severity' && 'The time to resolve follows the new severity, counted from when the incident opened.'}
            {dialog.kind === 'owner' && 'The new owner is told on their phone.'}
          </DialogDescription>
        </DialogHeader>
        {dialog.kind === 'severity' && (
          <select className={selectClass} value={severity} onChange={(e) => setSeverity(e.target.value as RiskTier)} aria-label="Severity">
            {SEVERITIES.map((s) => <option key={s} value={s}>{RISK_LABEL[s]}</option>)}
          </select>
        )}
        {dialog.kind === 'owner' && (
          <select className={selectClass} value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="New owner">
            <option value="">Choose a person…</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        )}
        <Field label={required ? 'Reason (recorded in the log)' : 'Note (optional)'}>
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="Reason" />
        </Field>
        <ErrorBox message={err} />
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button onClick={go} disabled={busy || (required && !text.trim()) || (dialog.kind === 'owner' && !owner)} data-testid="confirm-action">
            {dialog.kind === 'status' ? (reopening ? (i.status === 'resolved' ? 'Reopen' : 'Back to open') : dialog.to === 'resolved' ? 'Mark resolved' : 'Mark contained')
              : dialog.kind === 'severity' ? 'Change severity' : 'Hand over'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
