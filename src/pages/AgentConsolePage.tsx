import { Bot, CheckCircle2, Hourglass, Send, ShieldCheck, XCircle } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ErrorBox, LoadingRows, PageHeader } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { consoleRuns, type ConsoleStep } from '@/lib/agentConsole'
import { api } from '@/lib/api'
import { errorMessage, formatDateTime } from '@/lib/format'
import { useLive } from '@/lib/live'
import { useAsync } from '@/lib/useAsync'

const STEP_ICON: Record<ConsoleStep['kind'], typeof Bot> = { asked: Send, waiting: Hourglass, heard: ShieldCheck, acted: CheckCircle2 }

/**
 * Task 2.8: the agent console (demo, admins). Plays the Payment Release Assistant, an agent running outside the
 * Control Tower: it asks before releasing a payment, waits, and acts on the signed decision the Control Tower calls
 * back with. Add ?test=1 to the address to mark requests as tests (no alerts or emails to people).
 */
export function AgentConsolePage() {
  const [params] = useSearchParams()
  const test = params.get('test') === '1'
  const [amount, setAmount] = useState('2000000')
  const [supplier, setSupplier] = useState('Hartwell Steel Ltd')
  const [reason, setReason] = useState('Invoice HS-48817 for the Q4 steel order is due today and matches purchase order PO-2026-0912.')
  const [busy, setBusy] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)

  const { data, error, loading, reload } = useAsync(async () => consoleRuns(await api.demoAgentLog()))
  const waiting = data?.some((r) => r.waiting) ?? false

  // Something changed in the Control Tower (2.5): read again. While a run waits for its callback, also every 2 seconds.
  const { tick } = useLive()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (tick > 0) reload() }, [tick])
  useEffect(() => {
    if (!waiting) return
    const id = setInterval(() => reload(), 2000)
    return () => clearInterval(id)
  }, [waiting, reload])

  async function ask(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setAskError(null)
    try {
      await api.demoAgentAsk(Number(amount), supplier, reason, test)
      await reload()
    } catch (err) {
      setAskError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Agent console"
        subtitle="Demo: plays the Payment Release Assistant, an agent running outside the Control Tower. It asks before acting, and acts only on the signed decision the Control Tower sends back." />

      <form onSubmit={ask} className="bg-card grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
        <div className="flex items-center gap-2 sm:col-span-2">
          <Bot className="size-5" aria-hidden />
          <span className="font-medium">Payment Release Assistant</span>
          {test && <span className="bg-muted rounded px-1.5 text-xs">Test mode: no alerts or emails to people</span>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="console-amount">Amount (GBP)</Label>
          <Input id="console-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="console-supplier">Supplier</Label>
          <Input id="console-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="console-reason">Why the agent wants to do it</Label>
          <Textarea id="console-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={busy}><Send className="size-4" /> Ask the Control Tower</Button>
          <span className="text-muted-foreground text-xs">Above £250,000 the agent must wait for a person.</span>
        </div>
        {askError && <div className="sm:col-span-2"><ErrorBox message={askError} /></div>}
      </form>

      <section className="space-y-3">
        <h2 className="font-medium">What the agent did</h2>
        <ErrorBox message={error} />
        {loading && !data && <LoadingRows />}
        {data?.length === 0 && <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">Nothing yet. Ask the Control Tower above.</p>}
        <ul className="space-y-3" aria-live="polite">
          {data?.map((run) => (
            <li key={run.requestId} data-testid="console-run" className="bg-card space-y-2 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{run.description}</span>
                <Link to={`/approvals/requests/${run.requestId}`} className="text-muted-foreground text-sm hover:underline">{run.code}</Link>
              </div>
              <ol className="space-y-1.5 text-sm">
                {run.steps.map((s, i) => {
                  const Icon = s.kind === 'acted' && !s.proceeded ? XCircle : STEP_ICON[s.kind]
                  const tone = s.kind === 'acted' ? (s.proceeded ? 'text-emerald-700 dark:text-emerald-400 font-medium' : 'text-destructive font-medium')
                    : s.kind === 'waiting' ? 'text-muted-foreground' : ''
                  return (
                    <li key={i} data-testid={`console-step-${s.kind}`} className={`flex gap-2 ${tone}`}>
                      <Icon className={`mt-0.5 size-4 shrink-0 ${s.kind === 'waiting' ? 'animate-pulse' : ''}`} aria-hidden />
                      <span>{'at' in s && <span className="text-muted-foreground mr-1.5 text-xs">{formatDateTime(s.at)}</span>}{s.text}</span>
                    </li>
                  )
                })}
              </ol>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
