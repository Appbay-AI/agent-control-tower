// Task 3.2: on the Integrations page, the agent platforms Control Tower is connected to, with "Test connection".
import { CheckCircle2, Loader2, PlugZap, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ErrorBox, LoadingRows } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { errorMessage, formatDateTime } from '@/lib/format'
import { jobState, PLATFORM_KIND_LABEL } from '@/lib/platforms'
import type { PlatformConnection, PlatformJob } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'

const TONE_STYLE = {
  none: 'text-muted-foreground',
  running: 'text-muted-foreground',
  ok: 'text-green-700 dark:text-green-400',
  failed: 'text-red-700 dark:text-red-400',
} as const

function ConnectionRow({ connection }: { connection: PlatformConnection }) {
  const [job, setJob] = useState<PlatformJob | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const polling = useRef<number | null>(null)

  useEffect(() => {
    let live = true
    api.latestPlatformJob(connection.id).then((j) => { if (live) { setJob(j); setLoaded(true) } }, (e) => { if (live) { setError(errorMessage(e)); setLoaded(true) } })
    return () => { live = false; if (polling.current) window.clearTimeout(polling.current) }
  }, [connection.id])

  async function follow(id: number, until: number) {
    try {
      const j = await api.platformJob(id)
      setJob(j)
      if (!j.finished_at && Date.now() < until) polling.current = window.setTimeout(() => follow(id, until), 1000)
    } catch (e) { setError(errorMessage(e)) }
  }

  async function test() {
    setError(null)
    try {
      const id = await api.startPlatformCheck(connection.id)
      await follow(id, Date.now() + 2 * 60_000 + 5_000)
    } catch (e) { setError(errorMessage(e)) }
  }

  const state = jobState(job)
  const Icon = state.tone === 'ok' ? CheckCircle2 : state.tone === 'failed' ? XCircle : state.tone === 'running' ? Loader2 : PlugZap
  return (
    <li className="space-y-2 p-3" data-testid="platform-connection">
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
        <Button size="sm" variant="outline" onClick={test} disabled={state.tone === 'running' || !loaded}>
          Test connection
        </Button>
      </div>
      <div className={`flex items-start gap-1.5 text-sm ${TONE_STYLE[state.tone]}`} data-testid="platform-check">
        <Icon className={`mt-0.5 size-4 shrink-0 ${state.tone === 'running' ? 'animate-spin' : ''}`} />
        <span>
          {state.text}
          {job?.finished_at && <span className="text-muted-foreground text-xs"> · {formatDateTime(job.finished_at)}</span>}
        </span>
      </div>
      <ErrorBox message={error} />
    </li>
  )
}

export function PlatformConnections() {
  const { hasRole } = useAuth()
  const admin = hasRole('admin')
  const { data, error, loading } = useAsync(() => (admin ? api.platformConnections() : Promise.resolve([])), [admin])
  if (!admin) return null
  return (
    <section className="space-y-2">
      <div>
        <h2 className="font-semibold">Agent platforms</h2>
        <p className="text-muted-foreground text-sm">
          Platforms Control Tower reads agents from and can block them on. Their keys stay in the database; only our server uses them.
        </p>
      </div>
      <ErrorBox message={error} />
      {loading && !data && <LoadingRows rows={1} />}
      {data && (
        <ul className="bg-card divide-y rounded-lg border text-sm">
          {data.length === 0 && <li className="text-muted-foreground p-4">No platform connected yet.</li>}
          {data.map((c) => <ConnectionRow key={c.id} connection={c} />)}
        </ul>
      )}
    </section>
  )
}
