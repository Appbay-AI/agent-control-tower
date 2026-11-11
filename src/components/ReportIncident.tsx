// Task 4.5: report an incident on an agent from its page (the people who may suspend it). Opens the new case.
import { Siren } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorBox, Field, selectClass } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { errorMessage, RISK_LABEL } from '@/lib/format'
import { SEVERITIES } from '@/lib/incidents'
import type { Agent, RiskTier } from '@/lib/types'

export function ReportIncident({ agent }: { agent: Agent }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState<RiskTier>(agent.risk_tier)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function report() {
    setBusy(true); setErr(null)
    try {
      const i = await api.reportIncident(agent.id, title.trim(), severity, description.trim() || null)
      setOpen(false)
      navigate(`/incidents/${i.id}`)
    } catch (e) { setErr(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <>
      <Button variant="outline" onClick={() => { setOpen(true); setTitle(''); setDescription(''); setSeverity(agent.risk_tier); setErr(null) }}
        data-testid="report-incident"><Siren /> Report incident</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report an incident on {agent.agent_code}</DialogTitle>
            <DialogDescription>It opens a case owned by the agent's business owner, with a time to resolve set by its severity. It does not suspend the agent.</DialogDescription>
          </DialogHeader>
          <Field label="What went wrong">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-label="Title" placeholder="e.g. Refunded the wrong customer" />
          </Field>
          <Field label="Severity">
            <select className={selectClass} value={severity} onChange={(e) => setSeverity(e.target.value as RiskTier)} aria-label="Severity">
              {SEVERITIES.map((s) => <option key={s} value={s}>{RISK_LABEL[s]}</option>)}
            </select>
          </Field>
          <Field label="Details (optional)">
            <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Details" />
          </Field>
          <ErrorBox message={err} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={report} disabled={busy || !title.trim()} data-testid="report-incident-confirm">Report incident</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
