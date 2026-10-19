import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ErrorBox, selectClass } from '@/components/ui-bits'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/format'

export type Mode = 'approve' | 'reject' | 'escalate'

/** Approve (optional note), reject (reason required) or escalate to another approver (reason required). */
export function RequestDecisionPanel({ requestId, agentLive, targets, onDone }: {
  requestId: string
  agentLive: boolean
  targets: { id: string; full_name: string; job_title: string | null }[]
  onDone: (what: Mode) => void
}) {
  const [mode, setMode] = useState<Mode | null>(null)
  const [reason, setReason] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function choose(m: Mode | null) {
    setMode(m); setReason(''); setTo(''); setError(null)
  }

  async function confirm() {
    const why = reason.trim()
    if (mode === 'reject' && !why) { setError('Say why it is rejected. The agent and its owner will see the reason.'); return }
    if (mode === 'escalate' && !to) { setError('Choose who to escalate to.'); return }
    if (mode === 'escalate' && !why) { setError('Say why you are escalating it.'); return }
    setBusy(true); setError(null)
    try {
      if (mode === 'escalate') await api.escalateRequest(requestId, to, why)
      else await api.decideRequest(requestId, mode!, why || null)
      const done = mode!
      choose(null)
      onDone(done)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (mode === null) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button disabled={!agentLive} onClick={() => choose('approve')} className="bg-emerald-700 text-white hover:bg-emerald-800"
          title={agentLive ? undefined : 'The agent is no longer Live, so this can only be rejected'}>Approve</Button>
        <Button variant="outline" onClick={() => choose('reject')} className="text-red-700 hover:text-red-800 dark:text-red-400">Reject</Button>
        <Button variant="outline" disabled={targets.length === 0} onClick={() => choose('escalate')}>Escalate</Button>
      </div>
    )
  }

  const placeholder = {
    approve: 'Optional note, e.g. "Invoice and purchase order checked"',
    reject: 'Why is this rejected?',
    escalate: 'Why should someone else decide?',
  }[mode]

  return (
    <div className="bg-background space-y-3 rounded-md border p-3">
      {mode === 'escalate' && (
        <div className="space-y-1">
          <Label htmlFor="escalate-to">Escalate to</Label>
          <select id="escalate-to" className={selectClass} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose an approver…</option>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.full_name}{t.job_title ? ` · ${t.job_title}` : ''}</option>)}
          </select>
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="decision-reason">{mode === 'approve' ? 'Note (optional)' : 'Reason'}</Label>
        <Textarea id="decision-reason" autoFocus rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} />
      </div>
      <ErrorBox message={error} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={confirm} variant={mode === 'reject' ? 'destructive' : 'default'}
          className={mode === 'approve' ? 'bg-emerald-700 text-white hover:bg-emerald-800' : undefined}>
          {busy ? 'Saving…' : { approve: 'Confirm approval', reject: 'Confirm rejection', escalate: 'Escalate' }[mode]}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => choose(null)}>Cancel</Button>
      </div>
    </div>
  )
}
