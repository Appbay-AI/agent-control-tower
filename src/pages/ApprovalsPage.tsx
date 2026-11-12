import { CheckCheck, CheckCircle2, ChevronRight, Users } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { RiskBadge } from '@/components/badges'
import { AlertsCard } from '@/components/AlertsCard'
import { IncidentClosures } from '@/components/IncidentClosures'
import { ReactivationRequests } from '@/components/ReactivationRequests'
import { DecisionPanel } from '@/components/DecisionPanel'
import { UrgencyBadge } from '@/components/requestBadges'
import { ErrorBox, LoadingRows, PageHeader, TagList } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AUTONOMY, DATA_LABEL, formatDateTime, formatMoney } from '@/lib/format'
import { useAuth } from '@/lib/auth'
import { FALLBACK_POLL_MS, useLive, type LiveStatus } from '@/lib/live'
import { headline, requestAmount } from '@/lib/requests'
import { dueState } from '@/lib/sla'

/** Whether the list is updating on its own (task 2.5). */
function LiveIndicator({ status }: { status: LiveStatus }) {
  const text = status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…'
    : `Live updates paused · checking every ${FALLBACK_POLL_MS / 1000} seconds`
  return (
    <span data-testid="live-status" title={status === 'live' ? 'New tasks appear here on their own' : undefined}
      className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
      <span aria-hidden className={cn('size-2 rounded-full', status === 'live' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-slate-400' : 'bg-amber-500')} />
      {text}
    </span>
  )
}

function NewBadge() {
  return <span className="bg-brand-yellow text-brand-charcoal rounded px-1.5 text-[10px] leading-4 font-semibold uppercase">New</span>
}

export function ApprovalsPage() {
  const notice = (useLocation().state as { notice?: string } | null)?.notice
  const { hasRole } = useAuth()
  // Task 2.5: the list lives in LiveProvider and is read again whenever something changes.
  const { approvals: data, approvalsError: error, approvalsLoading: loading, reloadApprovals: reload, status, fresh } = useLive()

  // Bulk approval of low-risk requests (task 2.10).
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkNote, setBulkNote] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMsg, setBulkMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const bulkable = data?.myRequests.filter((x) => x.bulkable) ?? []
  const chosen = bulkable.filter((x) => selected.has(x.req.id))
  const toggle = (id: string) => setSelected((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n })

  async function approveSelected() {
    setBulkBusy(true)
    setBulkMsg(null)
    try {
      const res = await api.bulkApprove(chosen.map((x) => x.req.id), bulkNote.trim() || null)
      const ok = res.filter((x) => x.ok).length
      const failed = res.filter((x) => !x.ok)
      setBulkMsg({ ok: failed.length === 0, text: `${ok} approved.${failed.length ? ` Not approved: ${failed.map((f) => `${f.code ?? 'request'} (${f.message})`).join('; ')}.` : ''}` })
      setSelected(new Set())
      setBulkOpen(false)
      setBulkNote('')
      await reload()
    } catch (e) {
      setBulkMsg({ ok: false, text: errorMessage(e) })
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Approvals" subtitle="Actions agents want to take, and new agents waiting to go live" />
      <LiveIndicator status={status} />
      {hasRole('approver') && <AlertsCard />}
      {/* Task 4.6 */}
      {hasRole('approver', 'admin') && <ReactivationRequests />}
      {/* Task 4.9 */}
      {hasRole('approver', 'admin') && <IncidentClosures />}
      {notice && <p className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-2 text-sm dark:bg-emerald-950/40">{notice}</p>}
      <ErrorBox message={error} />
      {loading && !data && <LoadingRows />}

      {data && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Agent actions</h2>
          {bulkMsg && <p role="status" data-testid="bulk-result" className={cn('text-sm', bulkMsg.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive')}>{bulkMsg.text}</p>}
          {bulkable.length > 1 && (
            <div className="bg-muted/50 flex flex-wrap items-center gap-3 rounded-md px-3 py-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4" aria-label="Select all low-risk requests"
                  checked={chosen.length === bulkable.length} onChange={(e) => setSelected(new Set(e.target.checked ? bulkable.map((x) => x.req.id) : []))} />
                Low-risk requests: {chosen.length} of {bulkable.length} selected
              </label>
              <Button size="sm" disabled={chosen.length === 0} onClick={() => setBulkOpen(true)}>
                <CheckCheck className="size-4" /> Approve selected ({chosen.length})
              </Button>
            </div>
          )}
          {/* Screen readers announce new tasks as they arrive. */}
          <div aria-live="polite" className="space-y-3">
          {data.myRequests.length === 0 ? (
            <div className="text-muted-foreground flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm">
              <CheckCircle2 className="size-5 text-emerald-600" aria-hidden /> No agent action is waiting for your decision.
            </div>
          ) : (
            <ul className="space-y-3">
              {data.myRequests.map(({ req, agent: a, approvedBy, bulkable: canBulk }) => (
                <li key={req.id} className="flex items-stretch gap-2">
                  {bulkable.length > 1 && (
                    <label className="flex w-6 shrink-0 items-center justify-center">
                      {canBulk && <input type="checkbox" className="size-4" aria-label={`Select ${req.request_code}`}
                        checked={selected.has(req.id)} onChange={() => toggle(req.id)} />}
                    </label>
                  )}
                  <Link to={`/approvals/requests/${req.id}`} data-testid="request-card"
                    className={cn('bg-card hover:border-foreground/30 flex min-w-0 flex-1 items-center gap-3 rounded-lg border p-4 transition-colors',
                      fresh.has(req.id) && 'border-brand-yellow ring-brand-yellow/40 ring-2')}>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                        {fresh.has(req.id) && <NewBadge />}
                        <span>{req.request_code}</span>
                        <span>· {formatDateTime(req.requested_at)}</span>
                        <RiskBadge tier={a.risk_tier} />
                        {req.urgency !== 'normal' && <UrgencyBadge urgency={req.urgency} />}
                        {req.required_approvals > 1 && (
                          <span data-testid="four-eyes" className="inline-flex items-center gap-1 font-medium">
                            <Users className="size-3" aria-hidden /> Four-eyes · {approvedBy.length} of {req.required_approvals}
                          </span>
                        )}
                        {dueState(req.due_at) && (
                          <span data-testid="request-due" className={dueState(req.due_at)!.tone === 'ok' ? '' : 'font-medium text-red-700 dark:text-red-400'}>
                            · {dueState(req.due_at)!.text}
                          </span>
                        )}
                      </div>
                      <div className="font-medium">{headline(req, a.name)}</div>
                      {req.reasoning && <div className="text-muted-foreground line-clamp-2 text-sm">Because {req.reasoning}</div>}
                    </div>
                    {requestAmount(req) && <div className="text-lg font-semibold whitespace-nowrap tabular-nums">{requestAmount(req)}</div>}
                    <ChevronRight className="text-muted-foreground size-5 shrink-0" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {data.otherRequests.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-muted-foreground text-sm font-medium">Also waiting, for someone else</h3>
              <ul className="divide-y rounded-lg border text-sm">
                {data.otherRequests.map(({ req, agent: a, perms }) => (
                  <li key={req.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <Link to={`/approvals/requests/${req.id}`} className="hover:underline">
                      {headline(req, a.name)} <span className="text-muted-foreground">· {req.request_code}</span>
                    </Link>
                    <span className="text-muted-foreground text-xs whitespace-nowrap">
                      {perms.whyNot?.startsWith('You have approved') ? 'You approved · waiting for a second approver'
                        : req.assigned_to ? `With ${data.people.get(req.assigned_to) ?? 'former user'}` : `Any ${data.dept.get(a.department_id ?? '') ?? ''} approver`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          </div>
        </section>
      )}

      {data && <h2 className="pt-2 text-lg font-semibold">New agents</h2>}
      {data && data.mine.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-sm">
          <CheckCircle2 className="size-8 text-emerald-600" aria-hidden />
          No new agent is waiting for your approval.
        </div>
      )}

      <ul className="space-y-4">
        {data?.mine.map(({ reg, agent: a, perms }) => (
          <li key={reg.id} className="bg-card space-y-4 rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <Link to={`/agents/${a.id}`} className="text-lg font-semibold hover:underline">{a.name}</Link>
                {fresh.has(reg.id) && <> <NewBadge /></>}
                <div className="text-muted-foreground text-xs">
                  {a.agent_code} · {data.dept.get(a.department_id ?? '')} · submitted {formatDateTime(reg.submitted_at)}
                  {reg.submitted_by ? ` by ${data.people.get(reg.submitted_by)}` : ' via API'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <RiskBadge tier={a.risk_tier} />
                {reg.required_approvals > 1 && (
                  <span className="text-xs font-medium">Four-eyes · {perms.approvalsSoFar} of {reg.required_approvals}</span>
                )}
              </div>
            </div>
            <p className="text-sm">{a.purpose_statement}</p>
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div><dt className="text-muted-foreground text-xs uppercase">Owner</dt><dd>{data.people.get(a.business_owner_id ?? '')}</dd></div>
              <div><dt className="text-muted-foreground text-xs uppercase">Autonomy</dt>
                <dd>Level {a.autonomy_level} · {AUTONOMY[a.autonomy_level].name}
                  {a.value_threshold !== null && ` · up to ${formatMoney(a.value_threshold, a.threshold_currency)}`}</dd></div>
              <div><dt className="text-muted-foreground text-xs uppercase">Data</dt>
                <dd><TagList items={a.data_classifications.map((d) => DATA_LABEL[d])} /></dd></div>
              <div className="sm:col-span-3"><dt className="text-muted-foreground text-xs uppercase">Systems</dt>
                <dd><TagList items={a.systems_accessed} /></dd></div>
            </dl>
            <DecisionPanel registrationId={reg.id} onDone={() => reload()} compact />
          </li>
        ))}
      </ul>

      <Dialog open={bulkOpen} onOpenChange={(o) => { if (!o) setBulkOpen(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve {chosen.length} low-risk {chosen.length === 1 ? 'request' : 'requests'}?</DialogTitle>
            <DialogDescription>Each is approved and recorded on its own, as if you approved them one by one. The agents are told straight away.</DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
            {chosen.map(({ req, agent: a }) => <li key={req.id}>{req.request_code} · {headline(req, a.name)}</li>)}
          </ul>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-note">Note (optional)</Label>
            <Textarea id="bulk-note" rows={2} value={bulkNote} onChange={(e) => setBulkNote(e.target.value)} placeholder="e.g. Rotas checked against branch cover" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)}>Cancel</Button>
            <Button disabled={bulkBusy} onClick={approveSelected}>{bulkBusy ? 'Approving…' : `Approve ${chosen.length}`}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {data && data.others.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-muted-foreground text-sm font-medium">Also waiting, for someone else</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {data.others.map(({ reg, agent: a, perms }) => (
              <li key={reg.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <Link to={`/agents/${a.id}`} className="hover:underline">{a.name} <span className="text-muted-foreground">· {a.agent_code}</span></Link>
                <span className="text-muted-foreground text-xs">
                  {perms.alreadyDecided ? 'You approved · needs a second approver' : 'Not yours to decide'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
