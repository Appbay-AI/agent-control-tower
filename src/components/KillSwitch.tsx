// Task 4.1: the kill switch on an agent's page: the Suspend button and dialog, a waiting request (four-eyes for
// Critical agents) with Confirm / Withdraw, and who suspended it and why.
import { OctagonX } from 'lucide-react'
import { useState } from 'react'
import { ErrorBox } from '@/components/ui-bits'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { errorMessage, formatDateTime } from '@/lib/format'
import type { Agent, AgentSuspension } from '@/lib/types'

type Mode = 'suspend' | 'confirm' | 'withdraw'

const TEXT: Record<Mode, { title: (code: string) => string; button: string; placeholder: string; required: boolean }> = {
  suspend: { title: (c) => `Suspend ${c} now?`, button: 'Suspend now', placeholder: 'Why is it being suspended? (recorded in the audit trail)', required: true },
  confirm: { title: (c) => `Confirm the suspension of ${c}?`, button: 'Confirm suspension', placeholder: 'Note (optional)', required: false },
  withdraw: { title: () => 'Withdraw this suspension request?', button: 'Withdraw request', placeholder: 'Why is it withdrawn?', required: true },
}

/** `part`: the Suspend button for the page header, or the waiting / suspended notices for the page body. */
export function KillSwitch({ part, agent, suspensions, canSuspend, needsSecond, userId, isAdmin, onDone, name }: {
  part: 'button' | 'notices'
  agent: Agent
  suspensions: AgentSuspension[]
  canSuspend: boolean
  /** A Critical agent while admins require a second person. */
  needsSecond: boolean
  userId: string
  isAdmin: boolean
  onDone: () => Promise<void>
  name: (id: string | null) => string | null
}) {
  const [mode, setMode] = useState<Mode | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const waiting = suspensions.find((s) => s.status === 'waiting') ?? null
  const last = agent.status === 'suspended' ? suspensions.find((s) => s.status === 'done') ?? null : null

  function open(m: Mode) { setMode(m); setText(''); setError(null) }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'suspend') await api.suspendAgent(agent.id, text.trim())
      else if (mode === 'confirm') await api.confirmSuspension(waiting!.id, text.trim() || null)
      else if (mode === 'withdraw') await api.withdrawSuspension(waiting!.id, text.trim())
      setMode(null)
      await onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const t = mode ? TEXT[mode] : null
  return (
    <>
      {part === 'button' && agent.status === 'live' && canSuspend && !waiting && (
        <Button variant="destructive" onClick={() => open('suspend')} data-testid="suspend-button"><OctagonX /> Suspend</Button>
      )}

      {part === 'notices' && waiting && (
        <Alert variant="destructive" data-testid="suspension-waiting">
          <AlertTitle>Suspension waiting for a second person</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{name(waiting.requested_by)} asked to suspend this Critical agent on {formatDateTime(waiting.requested_at)}: “{waiting.reason}”.
              It keeps running until someone else confirms.</p>
            <div className="flex flex-wrap gap-2">
              {canSuspend && waiting.requested_by !== userId && (
                <Button size="sm" variant="destructive" onClick={() => open('confirm')}>Confirm suspension</Button>
              )}
              {(waiting.requested_by === userId || isAdmin) && (
                <Button size="sm" variant="outline" onClick={() => open('withdraw')}>Withdraw request</Button>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {part === 'notices' && last && (
        <Alert variant="destructive" data-testid="suspension-done">
          <AlertTitle>Suspended {formatDateTime(last.suspended_at)}</AlertTitle>
          <AlertDescription>
            By {name(last.requested_by)}{last.confirmed_by ? `, confirmed by ${name(last.confirmed_by)}` : ''}: “{last.reason}”. Every check the
            agent makes with the Control Tower is refused.
          </AlertDescription>
        </Alert>
      )}

      <Dialog open={mode !== null} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t?.title(agent.agent_code)}</DialogTitle>
            <DialogDescription>
              {mode === 'suspend' && (needsSecond
                ? 'This agent is Critical: a second person must confirm before it stops. Everyone who can confirm is alerted.'
                : 'It stops at once: every check it makes with the Control Tower is refused, and what it is waiting for can no longer be approved.')}
              {mode === 'confirm' && `${name(waiting?.requested_by ?? null)} asked: “${waiting?.reason}”. Confirming stops the agent at once.`}
              {mode === 'withdraw' && 'The agent keeps running.'}
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t?.placeholder} aria-label="Reason" />
          <ErrorBox message={error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMode(null)}>Cancel</Button>
            <Button variant={mode === 'withdraw' ? 'default' : 'destructive'} disabled={busy || (t?.required && !text.trim())} onClick={save}>
              {mode === 'suspend' && needsSecond ? 'Ask for suspension' : t?.button}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
