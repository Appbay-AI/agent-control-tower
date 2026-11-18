// Task 6.6 (R5.1, R5.2): the drift report (every change made to an agent on its platform outside the Control Tower:
// by agent, who, when and what was done) and sync health (each platform's last fetch, failures, agents seen, and what
// the fetches found). Done when: the reports match the records.
import { AlertTriangle, CheckCircle2, Download, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { DRIFT_LABEL } from '@/components/DriftList'
import { AXIS, Panel, Tip } from '@/components/charts'
import { ErrorBox, LoadingRows, PageHeader } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { duration, weekLabel } from '@/lib/dashboard'
import { driftCsv, healthState, type DriftReport, type PlatformHealth, type SyncHealth } from '@/lib/driftSync'
import { when } from '@/lib/format'
import type { DriftKind } from '@/lib/types'
import { useAsync } from '@/lib/useAsync'

const iso = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000))

export function DriftSyncPage() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'sync' ? 'sync' : 'drift'
  return (
    <div className="space-y-6">
      <PageHeader title="Drift and sync" subtitle="Changes made to agents on their platforms outside the Control Tower, and how well each platform's agent list is being fetched." />
      <div role="tablist" className="flex gap-1 border-b">
        {(['drift', 'sync'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setParams(t === 'sync' ? { tab: 'sync' } : {})}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t ? 'border-foreground' : 'text-muted-foreground border-transparent'}`}>
            {t === 'drift' ? 'Drift report' : 'Sync health'}
          </button>
        ))}
      </div>
      {tab === 'drift' ? <DriftTab /> : <SyncTab />}
    </div>
  )
}

function DriftTab() {
  const [from, setFrom] = useState(daysAgo(89))
  const [to, setTo] = useState(daysAgo(0))
  const [range, setRange] = useState({ from: daysAgo(89), to: daysAgo(0) })
  const { data, error, loading } = useAsync(() => api.driftReport(range.from, range.to), [range.from, range.to])
  const [kind, setKind] = useState<DriftKind | ''>('')
  const [actor, setActor] = useState('')
  const [search, setSearch] = useState('')

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => (!kind || r.kind === kind) && (!actor || r.actor === actor)
    && (!search || `${r.agent} ${r.external_id ?? ''}`.toLowerCase().includes(search.toLowerCase()))), [data, kind, actor, search])

  function download(r: DriftReport) {
    const url = URL.createObjectURL(new Blob([driftCsv(rows)], { type: 'text/csv;charset=utf-8' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `drift-report-${r.period.from}-to-${r.period.to}.csv` })
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  return (
    <div className="space-y-4" data-testid="drift-report">
      <form className="bg-card flex flex-wrap items-end gap-3 rounded-lg border p-4" onSubmit={(e) => { e.preventDefault(); if (from && to && from <= to) setRange({ from, to }) }}>
        <div className="space-y-1.5"><Label htmlFor="d-from">From</Label><Input id="d-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="d-to">To (including)</Label><Input id="d-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
        <Button type="submit" variant="outline">Show</Button>
        <p className="text-muted-foreground basis-full text-xs">Whole days in UTC. Each change is recorded when a fetch from the platform finds it.</p>
      </form>
      {error && <ErrorBox message={error} />}
      {loading && !data && <LoadingRows rows={5} />}
      {data && (
        <>
          <section className="grid gap-3 sm:grid-cols-3" aria-label="Drift summary">
            <div className="bg-card rounded-lg border p-3">
              <div className="text-2xl font-semibold" data-testid="drift-total">{data.total}</div>
              <div className="text-sm font-medium">Changes outside the Control Tower</div>
              <div className="text-muted-foreground text-xs">{weekLabel(data.period.from)} to {weekLabel(data.period.to)}</div>
            </div>
            <div className="bg-card min-w-0 rounded-lg border p-3 text-sm">
              <div className="mb-1 font-medium">Who made them</div>
              {data.by_actor.length === 0 ? <div className="text-muted-foreground text-xs">Nobody</div>
                : data.by_actor.slice(0, 4).map((x) => <div key={x.actor} className="flex justify-between gap-2 text-xs"><span className="min-w-0 truncate" title={x.actor}>{x.actor}</span><span className="tabular-nums">{x.changes}</span></div>)}
            </div>
            <div className="bg-card min-w-0 rounded-lg border p-3 text-sm">
              <div className="mb-1 font-medium">Agents changed most</div>
              {data.by_agent.length === 0 ? <div className="text-muted-foreground text-xs">None</div>
                : data.by_agent.slice(0, 4).map((x) => <div key={x.agent_id} className="flex justify-between gap-2 text-xs"><Link to={`/agents/${x.agent_id}`} className="min-w-0 truncate hover:underline" title={x.agent}>{x.agent}</Link><span className="tabular-nums">{x.changes}</span></div>)}
            </div>
          </section>

          <section className="bg-card space-y-3 rounded-lg border p-4" aria-label="Every change">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="d-kind">What changed</Label>
                <select id="d-kind" className="border-input bg-background h-9 rounded-md border px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value as DriftKind | '')}>
                  <option value="">Everything ({data.total})</option>
                  {Object.entries(data.by_kind).map(([k, n]) => <option key={k} value={k}>{DRIFT_LABEL[k as DriftKind] ?? k} ({n})</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="d-actor">Who</Label>
                <select id="d-actor" className="border-input bg-background h-9 max-w-56 rounded-md border px-2 text-sm" value={actor} onChange={(e) => setActor(e.target.value)}>
                  <option value="">Anyone</option>
                  {data.by_actor.map((x) => <option key={x.actor} value={x.actor}>{x.actor} ({x.changes})</option>)}
                </select>
              </div>
              <div className="space-y-1.5"><Label htmlFor="d-search">Agent</Label><Input id="d-search" placeholder="Name, code or platform ID" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
              <Button type="button" variant="outline" disabled={rows.length === 0} onClick={() => download(data)}><Download /> CSV ({rows.length})</Button>
            </div>
            {data.total > data.rows.length && <p className="text-xs text-amber-700 dark:text-amber-400">Showing the latest {data.rows.length.toLocaleString('en-GB')} of {data.total.toLocaleString('en-GB')}. Choose a shorter period to see them all.</p>}
            {rows.length === 0 ? <p className="text-muted-foreground text-sm">No changes outside the Control Tower{kind || actor || search ? ' match these filters' : ' in this period'}.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[56rem] text-sm" data-testid="drift-table">
                  <thead>
                    <tr className="text-muted-foreground text-left text-xs">
                      <th className="py-1 pr-3 font-medium">Detected (UTC)</th><th className="py-1 pr-3 font-medium">Agent</th><th className="py-1 pr-3 font-medium">What changed</th>
                      <th className="py-1 pr-3 font-medium">Expected → found</th><th className="py-1 pr-3 font-medium">Who</th><th className="py-1 pr-3 font-medium">What Control Tower did</th>
                      <th className="py-1 font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-t align-top" data-testid="drift-row" data-kind={r.kind}>
                        <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">{when(r.at)}</td>
                        <td className="py-1.5 pr-3"><Link to={`/agents/${r.agent_id}`} className="font-medium hover:underline">{r.agent}</Link>
                          {r.external_id && <div className="text-muted-foreground text-xs">{r.external_id} on {r.platform}</div>}</td>
                        <td className="py-1.5 pr-3">{DRIFT_LABEL[r.kind] ?? r.kind}</td>
                        <td className="py-1.5 pr-3">{r.expected} → <span className="font-medium">{r.observed}</span></td>
                        <td className="py-1.5 pr-3">{r.actor}</td>
                        <td className="py-1.5 pr-3">{r.action}{r.incident && <> · <Link to={`/incidents/${r.incident_id}`} className="hover:underline">{r.incident}</Link></>}</td>
                        <td className="py-1.5">{r.result}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function SyncTab() {
  const [days, setDays] = useState(14)
  const { data, error, loading, reload } = useAsync(() => api.syncHealth(days), [days])
  return (
    <div className="space-y-4" data-testid="sync-health">
      <div className="flex flex-wrap items-center gap-2">
        {[7, 14, 30, 90].map((n) => <Button key={n} size="sm" variant={days === n ? 'default' : 'outline'} onClick={() => setDays(n)}>Last {n} days</Button>)}
        <Button size="sm" variant="ghost" onClick={reload} disabled={loading}><RefreshCw /> Refresh</Button>
      </div>
      {error && <ErrorBox message={error} />}
      {loading && !data && <LoadingRows rows={5} />}
      {data && (
        data.platforms.length === 0 ? <p className="text-muted-foreground text-sm">No agent platform is connected.</p> : (
          <>
            {data.platforms.map((p) => <PlatformCard key={p.id} p={p} days={data.days} />)}
            <Notable data={data} />
          </>
        )
      )}
    </div>
  )
}

function PlatformCard({ p, days }: { p: PlatformHealth; days: number }) {
  const h = healthState(p)
  const ok = p.period.syncs - p.period.failed - p.period.not_finished
  const rate = p.period.syncs ? Math.round((ok / p.period.syncs) * 100) : null
  const Icon = h.state === 'healthy' ? CheckCircle2 : AlertTriangle
  const tone = h.state === 'healthy' ? 'text-emerald-700 dark:text-emerald-400' : h.state === 'off' ? 'text-muted-foreground' : 'text-red-700 dark:text-red-400'
  return (
    <section className="bg-card space-y-4 rounded-lg border p-4" aria-label={p.name} data-testid="platform-health">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{p.name}</h2>
          <p className="text-muted-foreground text-xs">{p.every_minutes ? `Fetched every ${p.every_minutes} minutes` : 'Automatic fetching off'}</p>
        </div>
        <span className={`flex items-center gap-1.5 text-sm font-medium ${tone}`} data-testid="health-state" data-state={h.state}><Icon className="size-4" aria-hidden />{h.text}</span>
      </div>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Last good fetch" value={p.last_ok ? `${duration((Date.now() - Date.parse(p.last_ok.at)) / 60_000)} ago` : 'Never'} note={p.last_ok?.message} />
        <Fact label="Last failure" value={p.last_failure ? `${duration((Date.now() - Date.parse(p.last_failure.at)) / 60_000)} ago` : 'None'} note={p.last_failure?.message ?? undefined} bad={!!p.failing_now} />
        <Fact label="Last 24 hours" value={`${p.day.syncs} fetches`} note={`${p.day.failed} failed`} bad={p.day.failed > 0} testId="fact-day" />
        <Fact label={`Last ${days} days`} value={`${p.period.syncs.toLocaleString('en-GB')} fetches${rate != null ? `, ${rate}% worked` : ''}`} note={`${p.period.failed} failed`} testId="fact-period" />
        <Fact label="Agents listed now" value={String(p.agents.listed)} note={`${p.agents.linked} in the Control Tower · ${p.agents.missing} gone missing · ${p.agents.first_seen} first seen in ${days} days`} testId="fact-agents" />
        <Fact label={`Found in ${days} days`} value={`${p.period.new} new, ${p.period.status_changed} status changes`} note={`${p.period.missing} gone missing, ${p.period.back} back`} testId="fact-found" />
        <Fact label="Reconciliation checks" value={p.reconciliations.checks.toLocaleString('en-GB')} note={`${p.reconciliations.reblocked} agents blocked again${p.reconciliations.failed ? `, ${p.reconciliations.failed} checks failed` : ''}`} />
      </dl>
      <Panel title="Fetches, day by day" sub="Each bar is a day's fetches; failed ones on top."
        table={[['Day', 'Fetches', 'Failed', 'Changes found'], ...p.by_day.map((d) => [weekLabel(d.day), d.syncs, d.failed, d.changes])]}>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={p.by_day.map((d) => ({ ...d, label: weekLabel(d.day), worked: d.syncs - d.failed }))} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
            <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" />
            <YAxis allowDecimals={false} {...AXIS} axisLine={false} />
            <Tooltip cursor={{ fill: 'var(--muted)' }} content={<Tip render={(d) => `${d.syncs} fetches · ${d.failed} failed · ${d.changes} changes found`} />} />
            <Legend content={() => (
              <ul className="text-muted-foreground mt-1 flex justify-center gap-4 text-xs">
                <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: 'var(--viz-series)' }} />Worked</li>
                <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: 'var(--destructive)' }} />Failed</li>
              </ul>
            )} />
            <Bar dataKey="worked" name="Worked" stackId="s" fill="var(--viz-series)" stroke="var(--card)" strokeWidth={1} maxBarSize={28} isAnimationActive={false} />
            <Bar dataKey="failed" name="Failed" stackId="s" fill="var(--destructive)" stroke="var(--card)" strokeWidth={1} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </Panel>
    </section>
  )
}

function Fact({ label, value, note, bad, testId }: { label: string; value: string; note?: string; bad?: boolean; testId?: string }) {
  return (
    <div data-testid={testId}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={`font-medium ${bad ? 'text-red-700 dark:text-red-400' : ''}`}>{value}</dd>
      {note && <dd className="text-muted-foreground text-xs break-words">{note}</dd>}
    </div>
  )
}

function Notable({ data }: { data: SyncHealth }) {
  return (
    <section className="bg-card rounded-lg border p-4" aria-label="Fetches that failed or found something" data-testid="notable">
      <h2 className="font-semibold">Fetches that failed or found something</h2>
      <p className="text-muted-foreground mb-2 text-xs">Last {data.days} days, newest first (the quiet ones are counted above, not listed).</p>
      {data.notable.length === 0 ? <p className="text-muted-foreground text-sm">Every fetch worked and found no change.</p> : (
        <ul className="divide-y text-sm">
          {data.notable.map((n) => (
            <li key={n.id} className="flex gap-3 py-1.5" data-testid="notable-row">
              <span className="text-muted-foreground w-32 shrink-0 text-xs tabular-nums">{when(n.at)}</span>
              <span className={`w-28 shrink-0 text-xs font-medium ${n.ok === false ? 'text-red-700 dark:text-red-400' : ''}`}>{n.kind === 'sync' ? 'Fetch' : 'Reconciliation'}{n.ok === false ? ' failed' : ''}</span>
              <span className="min-w-0 break-words">{n.message ?? 'Not finished'}<span className="text-muted-foreground"> · {n.platform}</span></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
