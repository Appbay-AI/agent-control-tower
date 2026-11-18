// Tasks 3.2 and 3.3: on the Integrations page, the agent platforms Control Tower is connected to: "Test connection",
// how often the agent list is fetched, and "Sync now".
import { CheckCircle2, Loader2, PlugZap, RefreshCw, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ErrorBox, LoadingRows, selectClass } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { errorMessage, formatDateTime } from '@/lib/format'
import { jobState, nextSyncText, PLATFORM_KIND_LABEL, syncChoices, syncEveryText } from '@/lib/platforms'
import { durationText } from '@/lib/sla'
import type { PlatformConnection, PlatformJob } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'

const TONE_STYLE = {
  none: 'text-muted-foreground',
  running: 'text-muted-foreground',
  ok: 'text-green-700 dark:text-green-400',
  failed: 'text-red-700 dark:text-red-400',
} as const

/** The latest job of one kind on a connection, with a button to start another; follows it until it finishes. */
function useJob(connectionId: string, kind: PlatformJob['kind'], onFinished?: () => void) {
  const [job, setJob] = useState<PlatformJob | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    let live = true
    api.latestPlatformJob(connectionId, kind).then(
      (j) => { if (live) { setJob(j); setLoaded(true) } },
      (e) => { if (live) { setError(errorMessage(e)); setLoaded(true) } })
    return () => { live = false; if (timer.current) window.clearTimeout(timer.current) }
  }, [connectionId, kind])

  async function follow(id: number, until: number) {
    try {
      const j = await api.platformJob(id)
      setJob(j)
      if (!j.finished_at && Date.now() < until) timer.current = window.setTimeout(() => follow(id, until), 1000)
      else if (j.finished_at) onFinished?.()
    } catch (e) { setError(errorMessage(e)) }
  }

  async function start() {
    setError(null)
    try {
      const id = await api.startPlatformJob(connectionId, kind)
      await follow(id, Date.now() + 2 * 60_000 + 5_000)
    } catch (e) { setError(errorMessage(e)) }
  }

  return { job, loaded, error, start }
}

function JobLine({ job, never, testId }: { job: PlatformJob | null; never: string; testId: string }) {
  const state = jobState(job, Date.now(), never)
  const Icon = state.tone === 'ok' ? CheckCircle2 : state.tone === 'failed' ? XCircle : state.tone === 'running' ? Loader2 : PlugZap
  return (
    <div className={`flex items-start gap-1.5 text-sm ${TONE_STYLE[state.tone]}`} data-testid={testId}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${state.tone === 'running' ? 'animate-spin' : ''}`} />
      <span>
        {state.text}
        {job?.finished_at && <span className="text-muted-foreground text-xs"> · {formatDateTime(job.finished_at)}</span>}
      </span>
    </div>
  )
}

function ConnectionRow({ connection, onChanged, onSynced }: {
  connection: PlatformConnection; onChanged: () => void; onSynced?: () => void
}) {
  const check = useJob(connection.id, 'check')
  const sync = useJob(connection.id, 'sync', onSynced)
  // Task 4.7: the reconciliation check (every 5 minutes, only while agents on this platform are suspended).
  const reconcile = useJob(connection.id, 'reconcile')
  const [every, setEvery] = useState(connection.sync_every_minutes === null ? '' : String(connection.sync_every_minutes))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const changed = every !== (connection.sync_every_minutes === null ? '' : String(connection.sync_every_minutes))

  async function saveInterval() {
    setSaving(true); setSaveError(null)
    try { await api.setPlatformSyncInterval(connection.id, every === '' ? null : Number(every)); onChanged() }
    catch (e) { setSaveError(errorMessage(e)) } finally { setSaving(false) }
  }

  const checking = jobState(check.job).tone === 'running'
  const syncing = jobState(sync.job).tone === 'running'
  const reconciling = jobState(reconcile.job).tone === 'running'
  const next = nextSyncText(connection.sync_every_minutes, sync.job?.created_at ?? null)
  return (
    <li className="space-y-3 p-3" data-testid="platform-connection">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium">{connection.name}</div>
          <div className="text-muted-foreground text-xs">
            {PLATFORM_KIND_LABEL[connection.kind] ?? connection.kind} · <span className="font-mono">{connection.base_url}</span>
          </div>
          <div className="text-muted-foreground text-xs">
            {connection.secret_set_at ? `API key stored ${formatDateTime(connection.secret_set_at)}`
              : 'No API key stored yet: run the Database migrations workflow with the APPIAN_API_KEY secret set.'}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={check.start} disabled={checking || !check.loaded}>Test connection</Button>
      </div>
      <JobLine job={check.job} never="Not tested yet" testId="platform-check" />

      <div className="space-y-2 border-t pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-medium" data-testid="sync-every">{syncEveryText(connection.sync_every_minutes)}</div>
            {next && <div className="text-muted-foreground text-xs" data-testid="next-sync">{next}</div>}
          </div>
          <Button size="sm" onClick={sync.start} disabled={syncing || !sync.loaded}>
            <RefreshCw className={syncing ? 'animate-spin' : ''} /> Sync now
          </Button>
        </div>
        <JobLine job={sync.job} never="Not synced yet" testId="platform-sync" />
        <div className="flex gap-2">
          <select className={`${selectClass} flex-1`} value={every} onChange={(e) => setEvery(e.target.value)} aria-label="Sync the agent list">
            <option value="">Automatic sync off</option>
            {syncChoices(connection.sync_every_minutes).map((m) => <option key={m} value={m}>Every {durationText(m)}</option>)}
          </select>
          <Button size="sm" variant="outline" disabled={saving || !changed} onClick={saveInterval}>Save</Button>
        </div>
        <p className="text-muted-foreground text-xs">Each sync is one call to the platform. Use Sync now when you need the list sooner.</p>
      </div>
      <div className="space-y-1 border-t pt-3" data-testid="reconcile">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium">Suspended agents checked every 5 minutes</div>
          {/* Task 7.3: check at once, e.g. on stage right after an agent is switched back on in the platform. */}
          <Button size="sm" variant="outline" onClick={reconcile.start} disabled={reconciling || !reconcile.loaded} data-testid="reconcile-now">
            <RefreshCw className={reconciling ? 'animate-spin' : ''} /> Check now
          </Button>
        </div>
        <JobLine job={reconcile.job} never="Nothing to check yet: no agent here is suspended and confirmed blocked" testId="platform-reconcile" />
        <p className="text-muted-foreground text-xs">
          One call per suspended agent, and none when nothing is suspended. One switched back on outside Control Tower is blocked again,
          with a Critical incident and an alert to admins.
        </p>
      </div>
      <ErrorBox message={check.error ?? sync.error ?? saveError} />
    </li>
  )
}

export function PlatformConnections() {
  const { hasRole } = useAuth()
  const admin = hasRole('admin')
  const { data, error, loading, reload } = useAsync(() => (admin ? api.platformConnections() : Promise.resolve([])), [admin])
  if (!admin) return null
  return (
    <section className="space-y-2">
      <div>
        <h2 className="font-semibold">Agent platforms</h2>
        <p className="text-muted-foreground text-sm">
          Platforms Control Tower reads agents from and can block them on. Their keys stay in the database; only our server uses them.
          Agents found there are listed on the Agent registry page.
        </p>
      </div>
      <ErrorBox message={error} />
      {loading && !data && <LoadingRows rows={1} />}
      {data && (
        <ul className="bg-card divide-y rounded-lg border text-sm">
          {data.length === 0 && <li className="text-muted-foreground p-4">No platform connected yet.</li>}
          {data.map((c) => <ConnectionRow key={`${c.id}-${c.sync_every_minutes}`} connection={c} onChanged={reload} />)}
        </ul>
      )}
    </section>
  )
}
