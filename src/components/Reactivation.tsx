// Task 4.6: switching a suspended agent back on, only through approval. On the agent's page: the "Ask to switch back
// on" button, a waiting request (Approve / Reject for approvers, Withdraw for the asker or an admin), and, once
// approved, how it was switched back on everywhere (platform, key, resume request, owner email).
import { Power } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ErrorBox } from '@/components/ui-bits'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { errorMessage, formatDateTime } from '@/lib/format'
import type { Agent, AgentEnforcement, AgentReactivation, Incident, ReactivationApproval } from '@/lib/types'
import { stepState } from '@/components/KillSwitch'

type Mode = 'ask' | 'approve' | 'reject' | 'withdraw'

const STEP_LABEL: Record<AgentEnforcement['method'], string> = {
  platform: 'On its platform:', api: 'Its API key:', webhook: 'Resume request:', email: 'Owner told:',
}
const STEP_TEXT = { pending: 'Working…', retrying: 'Retrying', done: 'Done', failed: 'Failed', cancelled: 'Stopped' } as const

/** What the person may do with the waiting request, if any. */
export function reactivationChoices(p: { pending: AgentReactivation | null; approvals: ReactivationApproval[]; userId: string
  canApprove: boolean; isAdmin: boolean }) {
  const mine = p.pending ? p.approvals.filter((a) => a.reactivation_id === p.pending!.id) : []
  const asker = p.pending?.requested_by === p.userId
  const already = mine.some((a) => a.approver_id === p.userId)
  return {
    approvalsSoFar: mine.length,
    canApprove: Boolean(p.pending) && p.canApprove && !asker && !already,
    canReject: Boolean(p.pending) && p.canApprove && !asker,
    canWithdraw: Boolean(p.pending) && (asker || p.isAdmin),
    alreadyApproved: already,
  }
}

export function Reactivation({ part, agent, reactivations, approvals, enforcements, incidents, canAsk, canApprove, userId, isAdmin, onDone, name }: {
  part: 'button' | 'notices'
  agent: Agent
  reactivations: AgentReactivation[]
  approvals: ReactivationApproval[]
  enforcements: AgentEnforcement[]
  incidents: Incident[]
  canAsk: boolean
  canApprove: boolean
  userId: string
  isAdmin: boolean
  onDone: () => Promise<void>
  name: (id: string | null) => string | null
}) {
  const [mode, setMode] = useState<Mode | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = reactivations.find((r) => r.status === 'pending') ?? null
  const latest = reactivations.find((r) => r.status !== 'pending') ?? null
  const choice = reactivationChoices({ pending, approvals, userId, canApprove, isAdmin })
  const openIncidents = incidents.filter((i) => i.status === 'open')
  // Shown after approval while the agent is Live: how it was switched back on.
  const restored = agent.status === 'live' && latest?.status === 'approved' ? latest : null
  const steps = restored ? enforcements.filter((e) => e.action === 'restore' && e.reactivation_id === restored.id) : []
  const working = part === 'notices' && steps.some((e) => stepState(e) === 'pending')
  const retrying = part === 'notices' && steps.some((e) => stepState(e) === 'retrying')
  useEffect(() => {
    if (!working && !retrying) return
    const t = window.setTimeout(() => { void onDone() }, working ? 2000 : 30_000)
    return () => window.clearTimeout(t)
  }, [working, retrying, enforcements, onDone])

  function open(m: Mode) { setMode(m); setText(''); setError(null) }
  async function save() {
    setBusy(true); setError(null)
    try {
      if (mode === 'ask') await api.requestReactivation(agent.id, text.trim())
      else if (mode === 'approve') await api.approveReactivation(pending!.id, text.trim() || null)
      else if (mode === 'reject') await api.rejectReactivation(pending!.id, text.trim())
      else if (mode === 'withdraw') await api.withdrawReactivation(pending!.id, text.trim() || null)
      setMode(null)
      await onDone()
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  const required = mode === 'ask' || mode === 'reject'
  return (
    <>
      {part === 'button' && agent.status === 'suspended' && canAsk && !pending && (
        <Button variant="outline" onClick={() => open('ask')} data-testid="ask-reactivation"
          disabled={openIncidents.length > 0 || !!agent.review_required_at}
          title={openIncidents.length ? `Contain ${openIncidents.map((i) => i.incident_code).join(', ')} first` : agent.review_required_at ? 'Record the required review first' : undefined}>
          <Power /> Ask to switch back on
        </Button>
      )}

      {part === 'notices' && agent.status === 'suspended' && canAsk && !pending && openIncidents.length > 0 && (
        <p className="text-muted-foreground text-sm" data-testid="reactivation-blocked">
          To ask for it to be switched back on, first mark {openIncidents.map((i) => i.incident_code).join(', ')} as Contained.
        </p>
      )}
      {/* Task 4.9: repeat incidents force a review first. */}
      {part === 'notices' && agent.status === 'suspended' && canAsk && !pending && openIncidents.length === 0 && agent.review_required_at && (
        <p className="text-muted-foreground text-sm" data-testid="reactivation-review-first">
          To ask for it to be switched back on, first record the required review ({agent.review_required_reason}).
        </p>
      )}

      {part === 'notices' && pending && (
        <Alert data-testid="reactivation-waiting">
          <AlertTitle>Waiting for approval to switch it back on</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{name(pending.requested_by)} asked on {formatDateTime(pending.requested_at)}: “{pending.reason}”. It stays suspended until
              {pending.required_approvals === 2 ? ' two people approve (Critical agent)' : ' someone else approves'}.
              {choice.approvalsSoFar > 0 && ` Approved so far by ${approvals.filter((a) => a.reactivation_id === pending.id).map((a) => name(a.approver_id)).join(' and ')}.`}</p>
            <div className="flex flex-wrap gap-2">
              {choice.canApprove && <Button size="sm" onClick={() => open('approve')} data-testid="approve-reactivation">Approve</Button>}
              {choice.canReject && <Button size="sm" variant="outline" onClick={() => open('reject')}>Reject</Button>}
              {choice.canWithdraw && <Button size="sm" variant="ghost" onClick={() => open('withdraw')}>Withdraw</Button>}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {part === 'notices' && agent.status === 'suspended' && !pending && latest && latest.status === 'rejected' && (
        <p className="text-muted-foreground text-sm">Last request to switch it back on was rejected by {name(latest.decided_by)} on {formatDateTime(latest.decided_at)}: “{latest.decision_reason}”.</p>
      )}

      {part === 'notices' && restored && (steps.some((e) => e.status !== 'done') || Date.now() - new Date(restored.decided_at!).getTime() < 7 * 864e5) && (
        <Alert data-testid="reactivation-done">
          <AlertTitle>Switched back on {formatDateTime(restored.decided_at)}</AlertTitle>
          <AlertDescription>
            <p>Asked by {name(restored.requested_by)}: “{restored.reason}”. Approved by {approvals.filter((a) => a.reactivation_id === restored.id).map((a) => name(a.approver_id)).join(' and ')}.</p>
            {steps.length > 0 && (
              <ul className="mt-2 space-y-1">
                {steps.map((e) => {
                  const s = stepState(e)
                  return (
                    <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 text-sm" data-testid={`restore-${e.method}`} data-state={s}>
                      <span className="bg-muted rounded px-1.5 py-0.5 text-[11px] font-medium">{STEP_TEXT[s]}</span>
                      <span className="font-medium">{STEP_LABEL[e.method]}</span>
                      <span>{e.detail ?? e.target}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      <Dialog open={mode !== null} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mode === 'ask' && `Ask to switch ${agent.agent_code} back on?`}
              {mode === 'approve' && `Approve switching ${agent.agent_code} back on?`}
              {mode === 'reject' && 'Keep it suspended?'}
              {mode === 'withdraw' && 'Withdraw this request?'}
            </DialogTitle>
            <DialogDescription>
              {mode === 'ask' && `Someone else must approve before it runs again${agent.risk_tier === 'critical' ? ' (two people, as it is Critical)' : ''}. They are alerted now.`}
              {mode === 'approve' && (pending?.required_approvals === 2 && choice.approvalsSoFar === 0
                ? 'A second person must approve too before it runs again.'
                : 'It goes Live at once and is switched back on everywhere it was stopped.')}
              {mode === 'reject' && 'It stays suspended; the person who asked is told why.'}
              {mode === 'withdraw' && 'It stays suspended.'}
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="Reason"
            placeholder={mode === 'ask' ? 'Why is it safe to switch it back on? (recorded)' : required ? 'Why? (recorded)' : 'Note (optional)'} />
          <ErrorBox message={error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMode(null)}>Cancel</Button>
            <Button onClick={save} disabled={busy || (required && !text.trim())} data-testid="reactivation-confirm">
              {mode === 'ask' ? 'Ask for approval' : mode === 'approve' ? 'Approve' : mode === 'reject' ? 'Reject' : 'Withdraw'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
