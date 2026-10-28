import { ArrowLeft, Copy, KeyRound, Pencil, Rocket, Send } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AgentLogList, CheckinsBody } from '@/components/AgentCheckins'
import { RegistrationBadge, RiskBadge, StatusBadge, WarningBadge } from '@/components/badges'
import { DecisionPanel } from '@/components/DecisionPanel'
import { ErrorBox, Field, LoadingRows, TagList } from '@/components/ui-bits'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import {
  AUTONOMY, DATA_LABEL, errorMessage, formatDate, formatDateTime, formatMoney, FRAMEWORK_LABEL, isReviewOverdue, REVIEW_LABEL,
} from '@/lib/format'
import { agentPermissions } from '@/lib/permissions'
import type { AuditEvent, ReviewOutcome } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'

export function AgentDetailPage() {
  const { id } = useParams()
  const { session, roles, scopeDepartmentIds } = useAuth()
  const userId = session!.user.id
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<'review' | 'retire' | null>(null)
  const [newKey, setNewKey] = useState<string | null>(null)

  const { data, error, loading, reload } = useAsync(async () => {
    const [agent, departments, profiles, registrations, decisions, reviews, activity, alerts, contact, logs] = await Promise.all([
      api.agent(id!), api.departments(), api.allProfiles(), api.registrations(id!), api.decisions(id!),
      api.reviews(id!), api.activity(id!), api.openAlerts(), api.agentContact(id!), api.agentLogs(id!),
    ])
    const people = new Map(profiles.map((p) => [p.id, p]))
    const canSeeKeys = roles.includes('admin') || [agent.business_owner_id, agent.technical_owner_id, agent.created_by].includes(userId)
    const keys = canSeeKeys ? await api.apiKeys(id!) : []
    const approvers = registrations.some((r) => r.status === 'pending') ? await api.approversFor(id!) : []
    return {
      agent, people, registrations, decisions, reviews, activity, keys, approvers, contact, logs,
      department: departments.find((d) => d.id === agent.department_id) ?? null,
      alerts: alerts.filter((a) => a.agent_id === agent.id),
    }
  }, [id])

  if (error) {
    return (
      <div className="space-y-4">
        <ErrorBox message={error} />
        <Link to="/agents" className="inline-flex items-center gap-1 text-sm hover:underline"><ArrowLeft className="size-4" /> All agents</Link>
      </div>
    )
  }
  if (loading && !data) return <LoadingRows rows={8} />
  if (!data) return null

  const { agent: a, people, registrations, decisions, reviews, activity, keys, department, alerts, approvers, contact, logs } = data
  const silent = alerts.some((al) => al.kind === 'agent_silent')
  const decidedBy = new Set(decisions.filter((d) => d.registration_id === registrations.find((r) => r.status === 'pending')?.id).map((d) => d.approver_id))
  const stillToDecide = approvers.filter((p) => !decidedBy.has(p.id)).map((p) => p.full_name)
  const orList = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
  const pending = registrations.find((r) => r.status === 'pending') ?? null
  const latest = registrations[0] ?? null
  const perms = agentPermissions({ agent: a, userId, roles, scopeDepartmentIds, pending, decisions })
  const name = (uid: string | null) => (uid ? people.get(uid)?.full_name ?? 'Former user' : null)
  const overdue = isReviewOverdue(a.next_review_date, a.status)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setActionError(null)
    try {
      await fn()
      await reload()
    } catch (e) {
      setActionError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <Link to="/agents" className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline">
        <ArrowLeft className="size-4" /> All agents
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-muted-foreground text-sm" data-testid="agent-code">{a.agent_code}</div>
          <h1 className="text-2xl font-semibold tracking-tight">{a.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={a.status} />
            <RiskBadge tier={a.risk_tier} />
            <span className="text-muted-foreground text-xs">Level {a.autonomy_level} · {AUTONOMY[a.autonomy_level].name}</span>
            {(!a.business_owner_id || people.get(a.business_owner_id)?.is_active === false) && <WarningBadge>No business owner</WarningBadge>}
            {overdue && <WarningBadge>Review overdue</WarningBadge>}
            {silent && <WarningBadge>Silent</WarningBadge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {perms.canEdit && <Button variant="outline" asChild><Link to={`/agents/${a.id}/edit`}><Pencil /> Edit</Link></Button>}
          {perms.canSubmit && (
            <Button disabled={busy || perms.submitBlockers.length > 0} onClick={() => run(() => api.submit(a.id))}
              title={perms.submitBlockers.length ? `Add ${perms.submitBlockers.join(', ')} first` : undefined}>
              <Send /> Submit for approval
            </Button>
          )}
          {perms.canGoLive && <Button disabled={busy} onClick={() => run(() => api.goLive(a.id))}><Rocket /> Put live</Button>}
          {perms.canReview && <Button variant="outline" disabled={busy} onClick={() => setDialog('review')}>Record review</Button>}
          {perms.canRetire && (
            <Button variant="ghost" className="text-red-700 dark:text-red-400" disabled={busy} onClick={() => setDialog('retire')}>Retire</Button>
          )}
        </div>
      </div>

      <ErrorBox message={actionError} />
      {perms.canSubmit && perms.submitBlockers.length > 0 && (
        <p className="text-muted-foreground text-sm">To submit for approval, add {perms.submitBlockers.join(', ')}.</p>
      )}

      {/* Approval state */}
      {pending && (
        <Alert className="border-brand-yellow bg-brand-yellow/10">
          <AlertTitle>Waiting for approval</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Submitted {formatDateTime(pending.submitted_at)}{pending.submitted_by ? ` by ${name(pending.submitted_by)}` : ' through the API'}.
              {pending.required_approvals > 1 && ` Critical agent: needs ${pending.required_approvals} approvers (${perms.approvalsSoFar} so far).`}
            </p>
            <p>
              {stillToDecide.length > 0
                ? <>Can be approved by <strong>{orList(stillToDecide)}</strong>{department ? `, the ${department.name} approvers` : ''}.</>
                : <>No approver covers {department?.name ?? 'this department'} yet. Ask an admin to assign one.</>}
            </p>
            {perms.canDecide && <DecisionPanel registrationId={pending.id} onDone={() => reload()} />}
            {perms.alreadyDecided && <p className="font-medium">You have approved. A second approver is needed.</p>}
          </AlertDescription>
        </Alert>
      )}
      {!pending && latest && latest.status !== 'approved' && a.status === 'proposed' && (
        <Alert variant={latest.status === 'rejected' ? 'destructive' : 'default'}>
          <AlertTitle>{latest.status === 'rejected' ? 'Rejected' : 'Sent back'} on {formatDate(latest.decided_at)}</AlertTitle>
          <AlertDescription>{latest.decision_reason}</AlertDescription>
        </Alert>
      )}
      {alerts.map((al) => (
        <Alert key={al.id} variant="destructive" data-testid={`alert-${al.kind}`}><AlertDescription>{al.message}</AlertDescription></Alert>
      ))}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Purpose">
            <p className="text-sm whitespace-pre-wrap">{a.purpose_statement || <span className="text-muted-foreground">No purpose statement yet.</span>}</p>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Allowed actions"><TagList items={a.in_scope_actions} /></Field>
              <Field label="Forbidden actions"><TagList items={a.out_of_scope_actions} /></Field>
            </dl>
          </Card>
          <Card title="Access">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Field label="Systems"><TagList items={a.systems_accessed} /></Field>
              <Field label="Data"><TagList items={a.data_classifications.map((d) => DATA_LABEL[d])} /></Field>
              <Field label="Credential">{[a.credential_type, a.credential_owner && `owned by ${a.credential_owner}`].filter(Boolean).join(', ') || '—'}</Field>
              <Field label="Control endpoint">{a.control_endpoint ?? '—'}</Field>
            </dl>
          </Card>
          <Card title="Autonomy and risk">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Field label="Autonomy">Level {a.autonomy_level} · {AUTONOMY[a.autonomy_level].name}<div className="text-muted-foreground text-xs">{AUTONOMY[a.autonomy_level].text}</div></Field>
              <Field label="Limits">
                {a.value_threshold !== null || a.volume_threshold !== null
                  ? [a.value_threshold !== null && `${formatMoney(a.value_threshold, a.threshold_currency)} per action`,
                     a.volume_threshold !== null && `${a.volume_threshold} actions a day`].filter(Boolean).join(' · ')
                  : '—'}
              </Field>
              <Field label="Risk tier"><RiskBadge tier={a.risk_tier} /></Field>
              <Field label="Regulations"><TagList items={a.regulatory_flags} /></Field>
            </dl>
          </Card>
          <Card title="Agent log" subtitle={`What the agent reported${logs.length >= 50 ? ' · latest 50 entries' : ''}. Entries cannot be edited or deleted.`}>
            <AgentLogList entries={logs} />
          </Card>
          <Card title="Activity" subtitle="From the tamper-proof audit trail">
            <Activity events={activity} name={name} />
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Ownership">
            <dl className="space-y-3">
              <Field label="Business owner">{a.business_owner_id
                ? <>{name(a.business_owner_id)} {people.get(a.business_owner_id)?.is_active === false && <WarningBadge>Deactivated</WarningBadge>}</>
                : <WarningBadge>Not assigned</WarningBadge>}</Field>
              <Field label="Technical owner">{a.technical_owner_id
                ? <>{name(a.technical_owner_id)} {people.get(a.technical_owner_id)?.is_active === false && <WarningBadge>Deactivated</WarningBadge>}</>
                : '—'}</Field>
              <Field label="Department">{department?.name ?? '—'}</Field>
              <Field label="Cost centre">{a.cost_centre ?? department?.cost_centre ?? '—'}</Field>
            </dl>
          </Card>
          <Card title="Check-ins">
            <CheckinsBody key={a.silent_after_minutes ?? 'off'} limit={a.silent_after_minutes} contact={contact} live={a.status === 'live'}
              canChange={perms.canManageKeys && a.status !== 'retired'}
              onSave={async (m) => { await api.setSilenceLimit(a.id, m); await reload() }} />
          </Card>
          <Card title="Lifecycle">
            <dl className="space-y-3">
              <Field label="Approved">{a.approved_at ? `${formatDate(a.approved_at)} by ${name(a.approved_by) ?? '—'}` : '—'}</Field>
              <Field label="Last review">{formatDate(a.last_review_date)}</Field>
              <Field label="Next review"><span className={overdue ? 'font-medium text-red-700 dark:text-red-400' : ''}>{formatDate(a.next_review_date)}{overdue && ' (overdue)'}</span></Field>
              <Field label="Registered">{formatDate(a.created_at)} · {a.registration_source === 'api' ? 'via API' : a.registration_source === 'discovered' ? 'discovered unregistered' : 'manually'}</Field>
            </dl>
          </Card>
          <Card title="Identity">
            <dl className="space-y-3">
              <Field label="Built by">{a.origin === 'vendor' ? `Vendor: ${a.vendor_name}` : 'Internal team'}</Field>
              <Field label="Framework">{FRAMEWORK_LABEL[a.framework]}</Field>
              <Field label="Version">{a.version ?? '—'}</Field>
              {a.description && <Field label="Description">{a.description}</Field>}
            </dl>
          </Card>
          <Card title="Approvals">
            {registrations.length === 0 ? <p className="text-muted-foreground text-sm">Not submitted yet.</p> : (
              <ul className="space-y-3 text-sm">
                {registrations.map((r) => (
                  <li key={r.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span>{formatDate(r.submitted_at)}</span>
                      <RegistrationBadge status={r.status} />
                    </div>
                    {decisions.filter((d) => d.registration_id === r.id).map((d) => (
                      <div key={d.id} className="text-muted-foreground text-xs">
                        {name(d.approver_id)}: {d.decision.replace('_', ' ')}{d.reason ? ` — ${d.reason}` : ''}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {reviews.length > 0 && (
            <Card title="Reviews">
              <ul className="space-y-2 text-sm">
                {reviews.map((r) => (
                  <li key={r.id}>
                    <div>{formatDate(r.reviewed_at)} · {REVIEW_LABEL[r.outcome]}</div>
                    <div className="text-muted-foreground text-xs">{name(r.reviewer_id)}{r.notes ? ` — ${r.notes}` : ''}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {perms.canManageKeys && (
            <Card title="API keys" subtitle="The agent uses its key to call Control Tower">
              <ul className="space-y-2 text-sm">
                {keys.map((k) => (
                  <li key={k.id} className="flex items-center justify-between gap-2">
                    <span className={k.revoked_at ? 'text-muted-foreground line-through' : 'font-mono text-xs'}>{k.key_prefix}…</span>
                    {k.revoked_at ? <span className="text-muted-foreground text-xs">revoked</span> : (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api.revokeKey(k.id))}>Revoke</Button>
                    )}
                  </li>
                ))}
                {keys.length === 0 && <li className="text-muted-foreground">No keys yet.</li>}
              </ul>
              <Button size="sm" variant="outline" className="mt-3" disabled={busy}
                onClick={() => run(async () => setNewKey(await api.createApiKey(a.id)))}>
                <KeyRound /> New key
              </Button>
            </Card>
          )}
        </div>
      </div>

      <ReviewDialog open={dialog === 'review'} onClose={() => setDialog(null)}
        onSave={(outcome, notes) => run(async () => { await api.review(a.id, outcome, notes); setDialog(null) })} busy={busy} error={actionError} />
      <RetireDialog open={dialog === 'retire'} onClose={() => setDialog(null)}
        onSave={(reason) => run(async () => { await api.retire(a.id, reason); setDialog(null) })} busy={busy} error={actionError} />
      <KeyDialog value={newKey} onClose={() => setNewKey(null)} />
    </div>
  )
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="bg-card rounded-lg border p-4">
      <h2 className="font-semibold">{title}</h2>
      {subtitle && <p className="text-muted-foreground text-xs">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

const ACTION_LABEL: Record<string, string> = {
  'agents.insert': 'Registered',
  'agents.update': 'Details changed',
  'agents.status_changed': 'Status changed',
  'agents.autonomy_changed': 'Autonomy changed',
  'agent_registrations.insert': 'Submitted for approval',
  'agent_registrations.update': 'Approval decided',
  'registration_decisions.insert': 'Approver decision',
  'agent_reviews.insert': 'Review recorded',
  'alerts.insert': 'Alert raised',
  'alerts.update': 'Alert cleared',
  'agent_api_keys.insert': 'API key created',
  'agent_api_keys.update': 'API key revoked',
}

function Activity({ events, name }: { events: AuditEvent[]; name: (id: string | null) => string | null }) {
  if (!events.length) return <p className="text-muted-foreground text-sm">No activity yet.</p>
  return (
    <ol className="space-y-3">
      {events.map((e) => {
        const changed = e.action === 'agents.update' && e.before && e.after
          ? Object.keys(e.after).filter((k) => JSON.stringify(e.after![k]) !== JSON.stringify(e.before![k]))
          : []
        const who = e.actor_type === 'user' ? name(e.actor_id) ?? 'A user'
          : e.actor_type === 'integration' ? 'Integration (API)' : e.actor_type === 'agent' ? 'The agent' : 'System'
        return (
          <li key={e.id} className="border-l-2 pl-3 text-sm">
            <div className="font-medium">{e.summary ?? ACTION_LABEL[e.action] ?? e.action}</div>
            <div className="text-muted-foreground text-xs">
              {formatDateTime(e.occurred_at)} · {who}
              {changed.length > 0 && ` · ${changed.map((c) => c.replaceAll('_', ' ')).join(', ')}`}
              {e.reason && ` · “${e.reason}”`}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function ReviewDialog({ open, onClose, onSave, busy, error }: {
  open: boolean; onClose: () => void; onSave: (o: ReviewOutcome, notes: string | null) => void; busy: boolean; error: string | null
}) {
  const [outcome, setOutcome] = useState<ReviewOutcome>('no_change')
  const [notes, setNotes] = useState('')
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record review</DialogTitle>
          <DialogDescription>Confirms the agent still matches its purpose, owner, access and limits. The next review is set 6 months out.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {(Object.keys(REVIEW_LABEL) as ReviewOutcome[]).map((o) => (
            <label key={o} className="flex items-center gap-2 text-sm">
              <input type="radio" name="outcome" checked={outcome === o} onChange={() => setOutcome(o)} /> {REVIEW_LABEL[o]}
            </label>
          ))}
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder={outcome === 'no_change' ? 'Notes (optional)' : 'What needs to change? (required)'} aria-label="Notes" />
          <ErrorBox message={error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => onSave(outcome, notes.trim() || null)}>Save review</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RetireDialog({ open, onClose, onSave, busy, error }: {
  open: boolean; onClose: () => void; onSave: (reason: string) => void; busy: boolean; error: string | null
}) {
  const [reason, setReason] = useState('')
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Retire this agent?</DialogTitle>
          <DialogDescription>It can no longer act. Its record and history are kept.</DialogDescription>
        </DialogHeader>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is it being retired?" aria-label="Reason" />
        <ErrorBox message={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy || !reason.trim()} onClick={() => onSave(reason.trim())}>Retire agent</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function KeyDialog({ value, onClose }: { value: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Dialog open={value !== null} onOpenChange={(o) => { if (!o) { onClose(); setCopied(false) } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy this key now</DialogTitle>
          <DialogDescription>It is shown only once. Store it in the agent's secret store, not in code.</DialogDescription>
        </DialogHeader>
        <code className="bg-muted block rounded p-3 font-mono text-xs break-all">{value}</code>
        <DialogFooter>
          <Button variant="outline" onClick={async () => { await navigator.clipboard.writeText(value ?? ''); setCopied(true) }}>
            <Copy /> {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button onClick={() => { onClose(); setCopied(false) }}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
