// Task 3.1 (resumed): "Connect Microsoft" on the Integrations page (admins). An admin signs in to Microsoft in the
// browser; the renewable sign-in is kept in the database's locked store. "Run Microsoft checks" then tests, from our
// server, what the Microsoft requirements rely on, and shows the answers here.
import { CheckCircle2, Loader2, LogIn, Unplug, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ErrorBox, LoadingRows } from '@/components/ui-bits'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { errorMessage, formatDateTime } from '@/lib/format'
import type { MicrosoftCheck } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'
import { cn } from '@/lib/utils'

const VERDICT_STYLE: Record<string, string> = {
  YES: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
  NO: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
  PARTLY: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
}

/** Microsoft's sign-in address with everything it needs (state and PKCE challenge come from the database). */
export function microsoftSignInUrl(s: { authorize_url: string; client_id: string; redirect_uri: string; scope: string; state: string;
  code_challenge: string; code_challenge_method: string }): string {
  const q = new URLSearchParams({ client_id: s.client_id, response_type: 'code', redirect_uri: s.redirect_uri, response_mode: 'query',
    scope: s.scope, state: s.state, code_challenge: s.code_challenge, code_challenge_method: s.code_challenge_method, prompt: 'select_account' })
  return `${s.authorize_url}?${q.toString()}`
}

export function MicrosoftConnect() {
  const { hasRole } = useAuth()
  const admin = hasRole('admin')
  const [params, setParams] = useSearchParams()
  const { data, error, loading, reload } = useAsync(() => (admin ? api.microsoftStatus() : Promise.resolve(null)), [admin])
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [check, setCheck] = useState<MicrosoftCheck | null>(null)
  const [testAgent, setTestAgent] = useState('Control Tower Test Agent')
  const [mayBlock, setMayBlock] = useState(false)
  const timer = useRef<number | null>(null)
  const outcome = params.get('microsoft')
  const reason = params.get('reason')

  useEffect(() => {
    if (!admin) return
    api.latestMicrosoftCheck().then(setCheck, () => undefined)
    return () => { if (timer.current) window.clearTimeout(timer.current) }
  }, [admin])

  if (!admin) return null

  async function connect() {
    setBusy(true); setActionError(null)
    try {
      window.location.assign(microsoftSignInUrl(await api.microsoftConnectStart()))
    } catch (e) { setActionError(errorMessage(e)); setBusy(false) }
  }

  async function disconnect() {
    setBusy(true); setActionError(null)
    try { await api.microsoftDisconnect(); await reload() } catch (e) { setActionError(errorMessage(e)) } finally { setBusy(false) }
  }

  async function follow(id: number, until: number) {
    try {
      const k = await api.microsoftCheck(id)
      setCheck(k)
      if (!k.finished_at && Date.now() < until) timer.current = window.setTimeout(() => follow(id, until), 1500)
      else if (k.finished_at) await reload()
    } catch (e) { setActionError(errorMessage(e)) }
  }

  async function runChecks() {
    setActionError(null)
    try {
      const id = await api.microsoftCheckStart(mayBlock && testAgent.trim() ? testAgent.trim() : null)
      await follow(id, Date.now() + 3 * 60_000)
    } catch (e) { setActionError(errorMessage(e)) }
  }

  const running = check !== null && !check.finished_at && Date.now() - new Date(check.created_at).getTime() < 3 * 60_000

  return (
    <section className="space-y-2" data-testid="microsoft-connect">
      <div>
        <h2 className="font-semibold">Microsoft Copilot Studio</h2>
        <p className="text-muted-foreground text-sm">
          An admin of the Microsoft tenant signs in once. Control Tower keeps a renewable sign-in in the database, where only our
          server can use it, to find agents and block them. This is a test connection until Microsoft is approved.
        </p>
      </div>
      {outcome === 'connected' && (
        <Alert data-testid="microsoft-outcome"><AlertDescription className="flex items-center justify-between gap-2">
          <span>Microsoft is connected.</span>
          <Button size="sm" variant="ghost" onClick={() => setParams({}, { replace: true })}>Dismiss</Button>
        </AlertDescription></Alert>
      )}
      {outcome === 'error' && (
        <Alert variant="destructive" data-testid="microsoft-outcome"><AlertDescription className="flex items-center justify-between gap-2">
          <span>Microsoft was not connected. {reason}</span>
          <Button size="sm" variant="ghost" onClick={() => setParams({}, { replace: true })}>Dismiss</Button>
        </AlertDescription></Alert>
      )}
      <ErrorBox message={error ?? actionError} />
      {loading && !data && <LoadingRows rows={1} />}
      {data && (
        <div className="bg-card space-y-3 rounded-lg border p-4 text-sm">
          {!data.app || !data.secret_set ? (
            <p className="text-muted-foreground" data-testid="microsoft-not-set-up">
              {!data.app ? 'The Microsoft app registration is not set up on this database yet.'
                : 'The app registration is known, but its client secret is not stored yet (GitHub secret MS_CLIENT_SECRET, then the Database migrations workflow).'}
            </p>
          ) : data.connected ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p data-testid="microsoft-state"><CheckCircle2 className="mr-1 inline size-4 text-emerald-600" aria-hidden />
                Connected as <strong>{data.account || 'an unnamed account'}</strong>{data.account_name ? ` (${data.account_name})` : ''}
                <span className="text-muted-foreground"> · by {data.connected_by ?? 'a former user'} on {formatDateTime(data.connected_at)}
                  {data.refreshed_at && data.refreshed_at !== data.connected_at ? ` · last used ${formatDateTime(data.refreshed_at)}` : ''}</span>
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={connect}><LogIn /> Sign in again</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={disconnect}><Unplug /> Disconnect</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p data-testid="microsoft-state" className="text-muted-foreground">Not connected.</p>
              <Button disabled={busy} onClick={connect} data-testid="microsoft-connect-button"><LogIn /> Connect Microsoft</Button>
            </div>
          )}
          {data.app && (
            <details className="text-muted-foreground text-xs">
              <summary className="cursor-pointer">App registration details</summary>
              <dl className="mt-2 grid gap-1 sm:grid-cols-[12rem_1fr]">
                <dt>Directory (tenant) ID</dt><dd className="font-mono break-all">{data.tenant_id}</dd>
                <dt>Application (client) ID</dt><dd className="font-mono break-all">{data.client_id}</dd>
                <dt>Redirect URI to register (Web)</dt><dd className="font-mono break-all" data-testid="microsoft-redirect">{data.redirect_uri ?? '—'}</dd>
                <dt>Client secret</dt><dd>{data.secret_set ? `stored ${formatDateTime(data.secret_set_at)}` : 'not stored'}</dd>
              </dl>
            </details>
          )}

          {data.connected && (
            <div className="space-y-2 border-t pt-3">
              <h3 className="font-medium">Microsoft checks</h3>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={mayBlock} onChange={(e) => setMayBlock(e.target.checked)} data-testid="microsoft-may-block" />
                  Block and then unblock this test agent:
                </label>
                <Input className="sm:w-64" value={testAgent} onChange={(e) => setTestAgent(e.target.value)} disabled={!mayBlock} aria-label="Test agent name" />
                <Button variant="outline" disabled={running} onClick={runChecks} data-testid="microsoft-run-checks">
                  {running ? <Loader2 className="animate-spin" /> : null} Run Microsoft checks
                </Button>
              </div>
              {check && <CheckResults check={check} running={running} />}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function CheckResults({ check, running }: { check: MicrosoftCheck; running: boolean }) {
  return (
    <div className="space-y-2" data-testid="microsoft-check">
      <p className={cn('text-xs', check.ok === false ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')}>
        {running ? 'Running… (up to a minute). Answers appear as they come in.' : !check.finished_at ? (
          <><XCircle className="mr-1 inline size-3.5" aria-hidden />Did not finish: our server stopped part way ({formatDateTime(check.created_at)}).
            {check.results?.length ? ' The answers it found are below.' : ' It found nothing before stopping.'}</>
        ) : (
          <>{check.ok ? <CheckCircle2 className="mr-1 inline size-3.5" aria-hidden /> : <XCircle className="mr-1 inline size-3.5" aria-hidden />}
            {check.message} · {formatDateTime(check.finished_at ?? check.created_at)}{check.test_agent ? ` · test agent "${check.test_agent}"` : ''}</>
        )}
      </p>
      {check.results && check.results.length > 0 && (
        <ul className="divide-y rounded-md border">
          {check.results.map((r) => (
            <li key={r.id} className="grid gap-1 p-2 sm:grid-cols-[3rem_1fr_6rem]" data-testid={`microsoft-result-${r.id}`}>
              <span className="text-muted-foreground font-mono text-xs">{r.id}{r.seconds !== undefined && <span className="block">{r.seconds} s</span>}</span>
              <div>
                <div>{r.question}</div>
                <div className="text-muted-foreground text-xs break-words">{r.detail}</div>
              </div>
              <span className={cn('h-fit w-fit rounded px-1.5 py-0.5 text-[11px] font-medium', VERDICT_STYLE[r.verdict] ?? 'bg-muted text-muted-foreground')}>{r.verdict}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
