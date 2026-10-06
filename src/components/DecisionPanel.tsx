import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ErrorBox } from '@/components/ui-bits'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/format'
import type { RegistrationDecision } from '@/lib/types'

/** Approve, send back or reject a registration. A reason is required for anything but approval. */
export function DecisionPanel({ registrationId, onDone, compact = false }: {
  registrationId: string
  onDone: (result: string) => void
  compact?: boolean
}) {
  const [mode, setMode] = useState<RegistrationDecision | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function decide(decision: RegistrationDecision) {
    if (decision !== 'approve' && !reason.trim()) {
      setError(decision === 'reject' ? 'Say why it is rejected.' : 'Say what needs to change.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api.decide(registrationId, decision, reason.trim() || undefined)
      onDone(result)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {mode && mode !== 'approve' && (
        <Textarea autoFocus rows={compact ? 2 : 3} value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder={mode === 'reject' ? 'Why is this agent rejected?' : 'What must the owner change before resubmitting?'}
          aria-label="Reason" />
      )}
      <ErrorBox message={error} />
      <div className="flex flex-wrap gap-2">
        {mode === null || mode === 'approve' ? (
          <>
            <Button disabled={busy} onClick={() => decide('approve')} className="bg-emerald-700 text-white hover:bg-emerald-800">
              {busy ? 'Saving…' : 'Approve'}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setMode('send_back')}>Send back</Button>
            <Button variant="outline" disabled={busy} onClick={() => setMode('reject')}
              className="text-red-700 hover:text-red-800 dark:text-red-400">Reject</Button>
          </>
        ) : (
          <>
            <Button disabled={busy} variant={mode === 'reject' ? 'destructive' : 'default'} onClick={() => decide(mode)}>
              {busy ? 'Saving…' : mode === 'reject' ? 'Confirm rejection' : 'Send back to owner'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setMode(null); setReason(''); setError(null) }}>Cancel</Button>
          </>
        )}
      </div>
    </div>
  )
}
