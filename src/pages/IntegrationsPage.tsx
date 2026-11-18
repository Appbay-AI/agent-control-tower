import { Copy, KeyRound, TerminalSquare } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { MicrosoftConnect } from '@/components/MicrosoftConnect'
import { MICROSOFT } from '@/lib/features'
import { PlatformConnections } from '@/components/PlatformConnections'
import { ErrorBox, LoadingRows, PageHeader } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { errorMessage, formatDateTime } from '@/lib/format'
import { useAsync } from '@/lib/useAsync'

const apiBase = typeof window === 'undefined' ? '' : window.location.origin

export function IntegrationsPage() {
  const { data, error, loading, reload } = useAsync(() => api.integrationKeys())
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true); setActionError(null)
    try {
      setNewKey(await api.createIntegrationKey(name.trim()))
      setName('')
      await reload()
    } catch (err) { setActionError(errorMessage(err)) } finally { setBusy(false) }
  }

  async function revoke(id: string) {
    setBusy(true); setActionError(null)
    try { await api.revokeKey(id); await reload() } catch (err) { setActionError(errorMessage(err)) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Integrations"
        subtitle="Integration keys let an agent platform register agents through the API. Each agent then gets its own key."
        actions={<Button asChild variant="outline"><Link to="/demo/agent"><TerminalSquare /> Agent console (demo)</Link></Button>} />

      <PlatformConnections />

      {/* Microsoft is switched off for now (src/lib/features.ts). */}
      {MICROSOFT && <MicrosoftConnect />}

      <h2 className="font-semibold">Integration keys</h2>
      <form onSubmit={create} className="bg-card flex flex-col gap-2 rounded-lg border p-4 sm:flex-row">
        <Input placeholder="Who will use this key, e.g. LangChain platform" value={name} onChange={(e) => setName(e.target.value)}
          aria-label="Key name" />
        <Button type="submit" disabled={busy || !name.trim()}><KeyRound /> Create integration key</Button>
      </form>
      <ErrorBox message={actionError ?? error} />
      {loading && !data && <LoadingRows rows={2} />}

      {data && (
        <ul className="divide-y rounded-lg border text-sm">
          {data.length === 0 && <li className="text-muted-foreground p-4">No integration keys yet.</li>}
          {data.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div>
                <div className="font-medium">{k.name}</div>
                <div className="text-muted-foreground text-xs">
                  <span className="font-mono">{k.key_prefix}…</span> · created {formatDateTime(k.created_at)}
                  {k.last_used_at && ` · last used ${formatDateTime(k.last_used_at)}`}
                </div>
              </div>
              {k.revoked_at ? <span className="text-muted-foreground text-xs">Revoked {formatDateTime(k.revoked_at)}</span>
                : <Button size="sm" variant="ghost" className="text-red-700 dark:text-red-400" disabled={busy} onClick={() => revoke(k.id)}>Revoke</Button>}
            </li>
          ))}
        </ul>
      )}

      <section className="bg-card space-y-2 rounded-lg border p-4 text-sm">
        <h2 className="font-semibold">Register an agent from code</h2>
        <pre className="bg-muted overflow-x-auto rounded p-3 text-xs">{`curl -X POST ${apiBase}/api/v1/agents/register \\
  -H "Authorization: Bearer <integration key>" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Invoice Matcher", "department": "Payments",
       "business_owner_email": "owner@bank.com",
       "purpose_statement": "Match invoices to purchase orders",
       "autonomy_level": 3, "value_threshold": 5000, "risk_tier": "medium"}'`}</pre>
        <p className="text-muted-foreground text-xs">
          The answer includes the agent's own key, shown once. Before acting, the agent calls
          <code className="mx-1">GET /api/v1/agents/&lt;code&gt;/status</code> with that key and acts only when <code>may_act</code> is true.
        </p>
      </section>

      <Dialog open={newKey !== null} onOpenChange={(o) => { if (!o) { setNewKey(null); setCopied(false) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy this key now</DialogTitle>
            <DialogDescription>It is shown only once. Give it to the platform team through your secret store.</DialogDescription>
          </DialogHeader>
          <code className="bg-muted block rounded p-3 font-mono text-xs break-all">{newKey}</code>
          <DialogFooter>
            <Button variant="outline" onClick={async () => { await navigator.clipboard.writeText(newKey ?? ''); setCopied(true) }}>
              <Copy /> {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button onClick={() => { setNewKey(null); setCopied(false) }}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
