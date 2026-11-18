// Task 6.3 (R5.3): the executive dashboard. One call to the database (executive_dashboard) gives every figure:
// headline numbers first, then agents by risk tier, where agents come from and how much of the agent platforms is
// governed, how long approvals take week by week, and incidents opened week by week. Done when: loads in under 3 s.
import { RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, LabelList, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AXIS, Panel, Tip } from '@/components/charts'
import { ErrorBox, LoadingRows, PageHeader } from '@/components/ui-bits'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { approvalTimeScale, coveragePercent, duration, TIER_LABEL, waitingFor, waitingTotal, weekLabel, type ExecutiveDashboard } from '@/lib/dashboard'
import { when } from '@/lib/format'
import { useAsync } from '@/lib/useAsync'

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`

export function DashboardPage() {
  const { hasRole } = useAuth()
  const { data, error, loading, reload } = useAsync(() => api.executiveDashboard())
  // Performance mark for the 3-second check (e2e reads it).
  useEffect(() => { if (data) performance.mark('act:dashboard-loaded') }, [data])

  if (error) return <ErrorBox message={error} />
  if (loading && !data) return <><PageHeader title="Executive dashboard" /><LoadingRows rows={6} /></>
  if (!data) return null
  return <Dashboard d={data} onRefresh={reload} busy={loading} canOpenApprovals={hasRole('approver', 'admin')} />
}

export function Dashboard({ d, onRefresh, busy, canOpenApprovals }: { d: ExecutiveDashboard; onRefresh: () => void; busy: boolean; canOpenApprovals: boolean }) {
  const waiting = waitingTotal(d.pending)
  const timeScale = approvalTimeScale(d.approval_time_by_week)
  const oldest = waitingFor(d.pending.oldest)
  const openIncidents = d.incidents.open + d.incidents.contained
  const cover = coveragePercent(d.coverage)
  const req = d.approval_time.requests

  return (
    <div className="space-y-6" data-testid="dashboard">
      <PageHeader title="Executive dashboard"
        subtitle={`Every agent in the Control Tower, as of ${when(d.at)} UTC. Approval times cover the last 30 days.`}
        actions={<Button variant="outline" onClick={onRefresh} disabled={busy}><RefreshCw /> Refresh</Button>} />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-6" aria-label="Headline figures">
        <Tile label="Active agents" value={d.agents} note={`${d.by_status.live} Live · ${d.by_status.suspended} suspended`} to="/agents" />
        <Tile label="Without an owner" value={d.no_owner.count} tone={d.no_owner.count ? 'bad' : undefined}
          note={d.no_owner.count ? d.no_owner.agents.map((a) => a.code).join(', ') : 'Every registered agent has one'} to="/agents?flag=no_owner" />
        <Tile label="Reviews overdue" value={d.overdue_reviews.count} tone={d.overdue_reviews.count ? 'warn' : undefined}
          note={d.overdue_reviews.count ? `Oldest due ${when(d.overdue_reviews.agents[0]?.due).replace(/ 00:00$/, '')}` : 'None'} to="/agents?flag=overdue" />
        <Tile label="Open incidents" value={openIncidents} tone={d.incidents.overdue ? 'bad' : undefined}
          note={`${d.incidents.contained} contained · ${d.incidents.overdue} past due`} to="/incidents" />
        <Tile label="Waiting for a decision" value={waiting} tone={waiting ? 'warn' : undefined}
          note={waiting ? `Oldest waiting ${oldest}` : 'Nothing waiting'} to={canOpenApprovals ? '/approvals' : undefined} />
        <Tile label="Average time to approve" text={duration(req.avg_minutes)}
          note={req.decided ? `Median ${duration(req.median_minutes)} · ${req.decided} decided` : 'No decisions in 30 days'} />
      </section>
      <p className="text-muted-foreground -mt-3 text-xs">
        Waiting: {count(d.pending.requests, 'action request')}, {count(d.pending.registrations, 'registration')},
        {' '}{count(d.pending.reactivations, 'request')} to switch back on, {count(d.pending.closures, 'incident closure')}.
        {' '}Agent registrations take {duration(d.approval_time.registrations.avg_minutes)} on average ({d.approval_time.registrations.decided} decided).
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Agents by risk tier" sub="Active agents; the bar's label is how many are Live."
          table={[['Risk tier', 'Agents', 'Live'], ...d.by_tier.map((t) => [TIER_LABEL[t.tier], t.agents, t.live])]}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={d.by_tier.map((t) => ({ ...t, label: TIER_LABEL[t.tier] }))} margin={{ top: 20, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
              <XAxis dataKey="label" {...AXIS} />
              <YAxis allowDecimals={false} {...AXIS} axisLine={false} />
              <Tooltip cursor={{ fill: 'var(--muted)' }} content={<Tip render={(p) => `${p.agents} agents · ${p.live} Live`} />} />
              <Bar dataKey="agents" name="Agents" fill="var(--viz-series)" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
                <LabelList dataKey="live" position="top" formatter={(v) => `${v} Live`} style={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Where agents come from" sub="Found automatically on agent platforms, or registered through the API or by hand."
          table={[['Source', 'Agents'], ['Found on agent platforms', d.by_source.platform], ['Registered through the API', d.by_source.api], ['Registered by hand', d.by_source.manual]]}>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart layout="vertical" margin={{ top: 0, right: 32, left: 8, bottom: 0 }}
              data={[{ k: 'Found on platforms', v: d.by_source.platform }, { k: 'Through the API', v: d.by_source.api }, { k: 'By hand', v: d.by_source.manual }]}>
              <CartesianGrid horizontal={false} stroke="var(--viz-grid)" />
              <XAxis type="number" allowDecimals={false} {...AXIS} />
              <YAxis type="category" dataKey="k" width={132} {...AXIS} axisLine={false} />
              <Tooltip cursor={{ fill: 'var(--muted)' }} content={<Tip render={(p) => `${p.v} agents`} />} />
              <Bar dataKey="v" name="Agents" fill="var(--viz-series)" radius={[0, 4, 4, 0]} maxBarSize={28} isAnimationActive={false}>
                <LabelList dataKey="v" position="right" style={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="mt-2 text-sm" data-testid="coverage">
            {d.coverage.listed === 0 ? 'No agent platform lists any agents yet.' : <>
              <span className="font-semibold">{cover ?? 0}% governed:</span> agent platforms list {count(d.coverage.listed, 'agent')}:
              {' '}{d.coverage.governed} approved in the Control Tower, {d.coverage.awaiting} waiting for approval,
              {' '}{d.coverage.unlinked} not in it yet{d.coverage.retired ? `, ${d.coverage.retired} retired and blocked` : ''}.
            </>}
          </p>
        </Panel>

        <Panel title="Time to approve, week by week" sub="Average time a person took to decide an agent's request (8 weeks)."
          table={[['Week of', 'Decided', 'Average'], ...d.approval_time_by_week.map((w) => [weekLabel(w.week), w.decided, duration(w.avg_minutes)])]}>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={d.approval_time_by_week.map((w) => ({ ...w, label: weekLabel(w.week), value: w.avg_minutes == null ? null : w.avg_minutes / timeScale.per }))}
              margin={{ top: 12, right: 16, left: -16, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
              <XAxis dataKey="label" {...AXIS} />
              <YAxis {...AXIS} axisLine={false} allowDecimals={timeScale.unit === 'h'} tickFormatter={(v: number) => `${Math.round(v * 10) / 10} ${timeScale.unit}`} />
              <Tooltip cursor={{ stroke: 'var(--viz-axis)' }} content={<Tip render={(p) => (p.decided ? `${duration(p.avg_minutes)} on average · ${p.decided} decided` : 'No decisions')} />} />
              <Line type="monotone" dataKey="value" name="Average" stroke="var(--viz-series)" strokeWidth={2}
                dot={{ r: 4, fill: 'var(--viz-series)', stroke: 'var(--card)', strokeWidth: 2 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Incidents opened, week by week" sub={`By severity (8 weeks). Open now: ${SEVERITIES.map((s) => `${d.incidents.by_severity[s]} ${TIER_LABEL[s]}`).join(', ')}.`}
          table={[['Week of', ...SEVERITIES.map((s) => TIER_LABEL[s])], ...d.incidents_by_week.map((w) => [weekLabel(w.week), ...SEVERITIES.map((s) => w[s])])]}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={d.incidents_by_week.map((w) => ({ ...w, label: weekLabel(w.week) }))} margin={{ top: 12, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
              <XAxis dataKey="label" {...AXIS} />
              <YAxis allowDecimals={false} {...AXIS} axisLine={false} />
              <Tooltip cursor={{ fill: 'var(--muted)' }}
                content={<Tip render={(p) => SEVERITIES.map((s) => `${TIER_LABEL[s]} ${p[s]}`).join(' · ')} />} />
              <Legend content={() => (
                <ul className="text-muted-foreground mt-1 flex justify-center gap-4 text-xs">
                  {SEVERITIES.map((s) => (
                    <li key={s} className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: `var(--viz-sev-${s})` }} />{TIER_LABEL[s]}</li>
                  ))}
                </ul>
              )} />
              {SEVERITIES.map((s, i) => (
                <Bar key={s} dataKey={s} name={TIER_LABEL[s]} stackId="sev" fill={`var(--viz-sev-${s})`} stroke="var(--card)" strokeWidth={1}
                  radius={i === SEVERITIES.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={40} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>
    </div>
  )
}

function Tile({ label, value, text, note, tone, to }: { label: string; value?: number; text?: string; note: string; tone?: 'bad' | 'warn'; to?: string }) {
  const color = tone === 'bad' ? 'text-red-700 dark:text-red-400' : tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : ''
  const body = (
    <>
      <div className={`text-2xl font-semibold ${color}`} data-testid="tile-value">{text ?? value?.toLocaleString('en-GB')}</div>
      <div className="text-sm font-medium">{label}</div>
      <div className="text-muted-foreground mt-0.5 truncate text-xs" title={note}>{note}</div>
    </>
  )
  const cls = 'bg-card block rounded-lg border p-3 text-left'
  return to
    ? <Link to={to} className={`${cls} transition hover:shadow-sm`} data-testid="tile" aria-label={`${label}: ${text ?? value}`}>{body}</Link>
    : <div className={cls} data-testid="tile">{body}</div>
}
