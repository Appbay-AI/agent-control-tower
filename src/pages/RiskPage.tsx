// Task 6.4: the risk dashboard. One call to the database (risk_dashboard): where the risk sits (active agents by
// department and risk tier, with open incidents and breaches), how breaches move week by week, and the agents with the
// most incidents. Done when: the figures match the data.
import { RefreshCw } from 'lucide-react'
import { Fragment } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AXIS, Panel, Tip } from '@/components/charts'
import { ErrorBox, LoadingRows, PageHeader } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { TIER_LABEL, weekLabel } from '@/lib/dashboard'
import { day, when } from '@/lib/format'
import { BREACHES, heatStep, type RiskDashboard } from '@/lib/risk'
import { useAsync } from '@/lib/useAsync'

const TIERS = ['low', 'medium', 'high', 'critical'] as const

export function RiskPage() {
  const { data, error, loading, reload } = useAsync(() => api.riskDashboard())
  if (error) return <ErrorBox message={error} />
  if (loading && !data) return <><PageHeader title="Risk dashboard" /><LoadingRows rows={6} /></>
  if (!data) return null
  return <Risk r={data} onRefresh={reload} busy={loading} />
}

export function Risk({ r, onRefresh, busy }: { r: RiskDashboard; onRefresh: () => void; busy: boolean }) {
  const max = Math.max(0, ...r.heat.flatMap((d) => TIERS.map((t) => d[t])))
  const total = (k: keyof RiskDashboard['heat'][number]) => r.heat.reduce((n, d) => n + Number(d[k]), 0)
  const breaches = BREACHES.reduce((n, b) => n + r.totals[b.kind], 0)

  return (
    <div className="space-y-6" data-testid="risk">
      <PageHeader title="Risk dashboard"
        subtitle={`Where the risk sits, as of ${when(r.at)} UTC. Breaches and incidents count the last 90 days (since ${day(r.since)}).`}
        actions={<Button variant="outline" onClick={onRefresh} disabled={busy}><RefreshCw /> Refresh</Button>} />

      <section className="bg-card rounded-lg border p-4" aria-label="Agents by department and risk tier">
        <h2 className="font-semibold">Agents by department and risk tier</h2>
        <p className="text-muted-foreground mb-3 text-xs">Active agents (not retired). The stronger the shade, the more agents; open incidents and breaches are per department.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-separate border-spacing-0.5 text-sm tabular-nums" data-testid="heat">
            <thead>
              <tr className="text-muted-foreground text-xs">
                <th className="py-1 text-left font-medium">Department</th>
                {TIERS.map((t) => <th key={t} className="w-20 py-1 text-center font-medium">{TIER_LABEL[t]}</th>)}
                <th className="w-16 py-1 text-right font-medium">Agents</th>
                <th className="w-24 py-1 text-right font-medium">Open incidents</th>
                <th className="w-24 py-1 text-right font-medium">Breaches</th>
              </tr>
            </thead>
            <tbody>
              {r.heat.map((d) => (
                <tr key={d.department} data-testid="heat-row">
                  <th scope="row" className="py-1 pr-2 text-left font-medium">{d.department}</th>
                  {TIERS.map((t) => {
                    const s = heatStep(d[t], max)
                    return (
                      <td key={t} className="h-9 rounded-sm text-center" data-tier={t}
                        title={`${d.department}, ${TIER_LABEL[t]}: ${d[t]} agent${d[t] === 1 ? '' : 's'}`}
                        style={s ? { background: `var(--viz-heat-${s})`, color: `var(--viz-heat-ink-${s})` } : { background: 'var(--muted)', color: 'var(--muted-foreground)' }}>
                        {d[t]}
                      </td>
                    )
                  })}
                  <td className="text-right">{d.agents}</td>
                  <td className={`text-right ${d.open_incidents ? 'font-medium text-red-700 dark:text-red-400' : ''}`}>{d.open_incidents}</td>
                  <td className="text-right">{d.breaches}</td>
                </tr>
              ))}
              <tr className="font-semibold" data-testid="heat-total">
                <th scope="row" className="border-t py-1 text-left">All departments</th>
                {TIERS.map((t) => <td key={t} className="border-t text-center">{total(t)}</td>)}
                <td className="border-t text-right">{total('agents')}</td>
                <td className="border-t text-right">{total('open_incidents')}</td>
                <td className="border-t text-right">{total('breaches')}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Breaches, week by week"
          sub={`${breaches} in 90 days: ${BREACHES.map((b) => `${r.totals[b.kind]} ${b.label.toLowerCase()}`).join(', ')}. A breach is any time an agent stepped outside its governance (12 weeks shown).`}
          table={[['Week of', ...BREACHES.map((b) => b.label)], ...r.trend.map((w) => [weekLabel(w.week), ...BREACHES.map((b) => w[b.kind])])]}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={r.trend.map((w) => ({ ...w, label: weekLabel(w.week) }))} margin={{ top: 12, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
              <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} {...AXIS} axisLine={false} />
              <Tooltip cursor={{ fill: 'var(--muted)' }} content={<Tip render={(p) => BREACHES.map((b) => `${b.label} ${p[b.kind]}`).join(' · ')} />} />
              <Legend content={() => (
                <ul className="text-muted-foreground mt-1 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
                  {BREACHES.map((b, i) => (
                    <li key={b.kind} className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: `var(--viz-cat-${i + 1})` }} />{b.label}</li>
                  ))}
                </ul>
              )} />
              {BREACHES.map((b, i) => (
                <Bar key={b.kind} dataKey={b.kind} name={b.label} stackId="b" fill={`var(--viz-cat-${i + 1})`} stroke="var(--card)" strokeWidth={1}
                  radius={i === BREACHES.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={36} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <section className="bg-card rounded-lg border p-4" aria-label="Agents with the most incidents">
          <h2 className="font-semibold">Agents with the most incidents</h2>
          <p className="text-muted-foreground mb-3 text-xs">Last 90 days; serious means High or Critical. Retired agents are included.</p>
          {r.top_agents.length === 0 ? <p className="text-muted-foreground text-sm">No incidents in the last 90 days.</p> : (
            <table className="w-full text-sm tabular-nums" data-testid="top-agents">
              <thead>
                <tr className="text-muted-foreground text-xs">
                  <th className="py-1 text-left font-medium">Agent</th>
                  <th className="py-1 pl-3 text-right font-medium">Incidents</th>
                  <th className="py-1 pl-3 text-right font-medium">Open</th>
                  <th className="py-1 pl-3 text-right font-medium">Serious</th>
                  <th className="hidden py-1 pl-3 text-right font-medium sm:table-cell">Last</th>
                </tr>
              </thead>
              <tbody>
                {r.top_agents.map((a) => (
                  <Fragment key={a.id}>
                    <tr className="border-t" data-testid="top-agent">
                      <td className="py-1.5 pr-2">
                        <Link to={`/agents/${a.id}`} className="font-medium hover:underline">{a.code} {a.name}</Link>
                        <div className="text-muted-foreground text-xs">{a.department ?? 'No department'} · {TIER_LABEL[a.risk_tier]} · {a.status === 'retired' ? 'Retired' : a.status.charAt(0).toUpperCase() + a.status.slice(1)}</div>
                      </td>
                      <td className="text-right font-semibold" data-testid="top-incidents">{a.incidents}</td>
                      <td className={`text-right ${a.open ? 'text-red-700 dark:text-red-400' : ''}`}>{a.open}</td>
                      <td className="text-right">{a.serious}</td>
                      <td className="text-muted-foreground hidden pl-3 text-right text-xs whitespace-nowrap sm:table-cell" title={`${when(a.last)} UTC`}>{day(a.last)}</td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  )
}
